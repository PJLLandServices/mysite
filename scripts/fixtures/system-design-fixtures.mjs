// scripts/fixtures/system-design-fixtures.mjs
//
// The characterization ("golden master") fixtures for the System Builder
// calculation engine.
//
// WHAT THESE ARE FOR
//
// The engine that turns a drawn design into zones, valves, a bill of
// materials and a price lives inside server/sitebuilder.html. It is being
// lifted out into a module it can be tested and reused from. Nothing about
// the formulas is allowed to move while that happens — a zone count, a GPM
// figure or a BOM quantity that shifts by one is a real job priced wrong.
//
// So before touching the engine we pin its CURRENT answers: run these
// fixtures through the old in-page engine, record every number it produces
// (scripts/capture-system-design-golden.mjs), and then require the
// extracted engine to reproduce them exactly.
//
// These are not assertions about what the engine SHOULD say. They are a
// record of what it DOES say. A golden master does not care whether the
// answer is right — only that it does not change while the code moves.
//
// SHAPE OF A FIXTURE
//
//   id       stable key in the golden file; never renamed or reordered
//   why      the boundary this case exists to hold down
//   inputs   { ceiling, spacingFactor } — the two global figures the
//            engine reads (on the page they are form fields)
//   areas    the design, exactly as sitebuilder saves it in
//            project.systemDesign.areas
//   routing  sheet routing, as saved in project.systemDesign.routing —
//            valve boxes and driveway splits. Only the DATA is used; no
//            site-plan raster is involved.
//   valveGroupModes  shared drip groups built as one valve per box
//
// DETERMINISM
//
// Every area carries an explicit `aid` and every manifold an explicit
// `id`. The engine mints those with Math.random() when they are missing,
// and a random id would leak into zone keys and make the golden file
// different on every run. Supplying them is the fixtures' job.
//
// Areas are deep-cloned before each run: ensureArea() migrates legacy
// fields and fills family defaults IN PLACE, so a shared object would be
// normalized by the first engine and handed already-normalized to the
// second.

/** Deep clone so neither engine sees the other's in-place normalization. */
export const clone = (v) => JSON.parse(JSON.stringify(v));

// ── Building blocks ──────────────────────────────────────────────────
//
// An L-shaped back lawn, traced off a sheet. Concave, so it exercises the
// polygon head placement and the neighbour-count arc rule rather than the
// rectangle grid.
const L_LAWN = [
  { x: 0,  y: 0  }, { x: 46, y: 0  }, { x: 46, y: 22 },
  { x: 20, y: 22 }, { x: 20, y: 40 }, { x: 0,  y: 40 }
];

// A kidney-ish bed outline — deliberately NOT orthogonal, so the drip run
// direction falls through to the single-direction branch.
const CURVED_BED = [
  { x: 0, y: 0 }, { x: 14, y: 2 }, { x: 22, y: 9 },
  { x: 18, y: 17 }, { x: 7, y: 16 }, { x: 1, y: 8 }
];

export const fixtures = [
  // ── 1. The residential shape the tool was built for ────────────────
  //
  // Front lawn, two side strips, back lawn. Four areas, three families,
  // rectangle + traced outline. This is the everyday case; if anything
  // here moves, everything moves.
  {
    id: "residential-four-area",
    why: "Representative whole-job design: mixed families, rect + traced, multi-zone.",
    inputs: { ceiling: 7.8, spacingFactor: 1 },
    areas: [
      { aid: "a_front001", name: "Front lawn", mode: "rect", L: 42, W: 26, sqft: 1092, avgW: 26,
        family: "spray", sprayBody: "b4", spraySeries: "s12" },
      { aid: "a_sideN002", name: "North side strip", mode: "rect", L: 58, W: 5, sqft: 290, avgW: 5,
        family: "strip", stripNoz: "sst", stripBody: "b4" },
      { aid: "a_sideS003", name: "South side strip", mode: "rect", L: 58, W: 4, sqft: 232, avgW: 4,
        family: "strip", stripNoz: "cst", stripBody: "b6" },
      { aid: "a_back0004", name: "Back lawn", mode: "custom", shapeKind: "poly", poly: clone(L_LAWN),
        L: 46, W: 40, sqft: 1552, avgW: 40, family: "rotor", rotorNoz: "b40" }
    ]
  },

  // ── 2. Zone splitting: the 4/4/2 case the balancer exists for ──────
  //
  // Ten equal rotor heads under a ceiling that fits four. The greedy fill
  // gives 4/4/2; the balancing pass must give 4/3/3 WITHOUT changing the
  // valve count. Pinning this is the whole point — a regression here is
  // invisible on the bid and obvious in the lawn.
  {
    id: "zone-split-balanced-ten-heads",
    why: "Zone splitting: greedy fill would strand a half-empty valve; the balancer must even it out at the same valve count.",
    inputs: { ceiling: 16.0, spacingFactor: 1 },
    areas: [
      { aid: "a_bal00001", name: "Balancer lawn", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 0, y: 30 }],
        L: 100, W: 30, sqft: 3000, avgW: 30,
        family: "rotor", rotorNoz: "b40",
        layout: "manual",
        manualHeads: Array.from({ length: 10 }, (_, i) => ({
          x: 5 + i * 10, y: 15, arc: 360, dir: 0, noz: "b40"
        }))
      }
    ]
  },

  // ── 3. Zone splitting: one head heavier than the whole ceiling ─────
  //
  // A single head over the ceiling is the one case a zone is ALLOWED to
  // exceed it — it cannot be cut in half. Sits next to small heads so the
  // packer has to keep it alone without wrecking the rest.
  {
    id: "zone-split-single-head-over-ceiling",
    why: "Boundary: a head bigger than the ceiling gets its own valve and is permitted to exceed it.",
    inputs: { ceiling: 2.0, spacingFactor: 1 },
    areas: [
      { aid: "a_over0001", name: "Oversize head", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 30 }, { x: 0, y: 30 }],
        L: 60, W: 30, sqft: 1800, avgW: 30,
        family: "rotor", rotorNoz: "b40",
        layout: "manual",
        manualHeads: [
          { x: 10, y: 15, arc: 90,  dir: 0, noz: "b15" },
          { x: 25, y: 15, arc: 360, dir: 0, noz: "b40" },
          { x: 40, y: 15, arc: 90,  dir: 0, noz: "b15" }
        ]
      }
    ]
  },

  // ── 4. Zone splitting: sum lands EXACTLY on the ceiling ────────────
  //
  // Float comparison boundary. Four heads at 1.95 GPM under a 7.8 ceiling
  // is exactly one zone — but only if the epsilon holds. Without it,
  // 7.800000000000001 starts a second valve and the quote grows a line.
  {
    id: "zone-split-exactly-on-ceiling",
    why: "Rounding boundary: six 1.3 GPM heads sum to EXACTLY the 7.8 ceiling and must stay ONE valve, not spill into two.",
    inputs: { ceiling: 7.8, spacingFactor: 1 },
    areas: [
      // Six 12-series sprays at 180 degrees are 1.3 GPM each — 7.8 on the
      // nose. Without the epsilon in the packer, 7.800000000000001 starts a
      // second valve and the quote grows a line nobody asked for.
      { aid: "a_exact001", name: "Exactly at ceiling", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 25 }, { x: 0, y: 25 }],
        L: 70, W: 25, sqft: 1750, avgW: 25,
        family: "spray", sprayBody: "b4", spraySeries: "s12",
        layout: "manual",
        manualHeads: [
          { x: 10, y: 12, arc: 180, dir: 0, noz: "s12" },
          { x: 20, y: 12, arc: 180, dir: 0, noz: "s12" },
          { x: 30, y: 12, arc: 180, dir: 0, noz: "s12" },
          { x: 40, y: 12, arc: 180, dir: 0, noz: "s12" },
          { x: 50, y: 12, arc: 180, dir: 0, noz: "s12" },
          { x: 60, y: 12, arc: 180, dir: 0, noz: "s12" }
        ]
      }
    ]
  },

  // ── 4b. Float drift at the fill boundary ────────────────────────────
  //
  // 2.4 + 2.5 + 3.0 + 0.8 is 8.7, and in binary floating point it is
  // 8.700000000000001. The packer compares against `ceiling + 0.001` for
  // exactly this reason. Take that epsilon away and these four heads —
  // which fit on one valve by any arithmetic a person would do — become
  // two valves, two run times and an extra line on the bid.
  //
  // The 7.8 case above does not catch it, because 1.3 x 6 happens to land
  // dead on 7.8 with no drift. This one does: it was found by searching
  // the real Hunter PGP flow table for a sum that drifts.
  {
    id: "zone-split-float-drift-on-fill",
    why: "Rounding boundary: a sum that drifts to 8.700000000000001 under an 8.7 ceiling must still be ONE valve.",
    inputs: { ceiling: 8.7, spacingFactor: 1 },
    areas: [
      { aid: "a_drift001", name: "Drifting sum lawn", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 30 }, { x: 0, y: 30 }],
        L: 60, W: 30, sqft: 1800, avgW: 30,
        family: "rotor", rotorNoz: "b25",
        layout: "manual",
        manualHeads: [
          { x: 10, y: 15, arc: 360, dir: 0, noz: "b25" },  // 2.4
          { x: 22, y: 15, arc: 360, dir: 0, noz: "r6"  },  // 2.5
          { x: 34, y: 15, arc: 360, dir: 0, noz: "b30" },  // 3.0
          { x: 46, y: 15, arc: 360, dir: 0, noz: "r2"  }   // 0.8
        ]
      },
      // Same four heads, this time all put on one valve BY HAND. A
      // hand-picked zone over the ceiling is reported rather than
      // re-split — and "over" needs the same epsilon, or this valve gets
      // flagged as overloaded when it is exactly at its limit.
      { aid: "a_drift001b", name: "Drifting sum, hand-zoned", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 70 }, { x: 0, y: 70 }],
        L: 60, W: 30, sqft: 1800, avgW: 30,
        family: "rotor", rotorNoz: "b25",
        layout: "manual",
        manualHeads: [
          { x: 10, y: 55, arc: 360, dir: 0, noz: "b25", zone: 0 },  // 2.4
          { x: 22, y: 55, arc: 360, dir: 0, noz: "r6",  zone: 0 },  // 2.5
          { x: 34, y: 55, arc: 360, dir: 0, noz: "b30", zone: 0 },  // 3.0
          { x: 46, y: 55, arc: 360, dir: 0, noz: "r2",  zone: 0 }   // 0.8
        ]
      }
    ]
  },

  // ── 4c. Float drift inside the BALANCER ─────────────────────────────
  //
  // Same epsilon, a different place: the balancing pass asks "is this run
  // of heads a legal zone?" for every candidate cut. Drop the epsilon
  // there and cuts that are legal get rejected, so the balancer picks a
  // worse split — 3.0/2.6 | 3.0/3.8 | 5.0/4.1 becomes 3.0/2.6/3.0 |
  // 3.8/5.0 | 4.1. Same valve count, lopsided valves.
  {
    id: "zone-split-float-drift-in-balancer",
    why: "Rounding boundary: the balancer's own ceiling test needs the epsilon too, or it rejects legal cuts and splits unevenly.",
    inputs: { ceiling: 9.1, spacingFactor: 1 },
    areas: [
      { aid: "a_drift002", name: "Drifting balancer lawn", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 30 }, { x: 0, y: 30 }],
        L: 90, W: 30, sqft: 2700, avgW: 30,
        family: "rotor", rotorNoz: "b30",
        layout: "manual",
        manualHeads: [
          { x: 8,  y: 15, arc: 360, dir: 0, noz: "b30" },  // 3.0
          { x: 22, y: 15, arc: 360, dir: 0, noz: "g25" },  // 2.6
          { x: 36, y: 15, arc: 360, dir: 0, noz: "b30" },  // 3.0
          { x: 50, y: 15, arc: 360, dir: 0, noz: "r8"  },  // 3.8
          { x: 64, y: 15, arc: 360, dir: 0, noz: "b50" },  // 5.0
          { x: 78, y: 15, arc: 360, dir: 0, noz: "g45" }   // 4.1
        ]
      }
    ]
  },

  // ── 5. Manual overrides: hand-assigned zones, incl. one over ceiling ─
  //
  // Heads given a zone by hand keep it, zone numbers compact to 1,2,3,
  // and anything left on Auto packs into zones AFTER the hand-picked
  // ones. A hand-picked zone over the ceiling must be REPORTED (overZones)
  // and not silently re-split — re-splitting would undo the decision.
  {
    id: "manual-override-hand-zoned",
    why: "Manual overrides: hand-assigned zones survive, compact to 1..n, auto heads pack after them, an over-ceiling hand zone is flagged not re-split.",
    inputs: { ceiling: 5.0, spacingFactor: 1 },
    areas: [
      { aid: "a_hand0001", name: "Hand-zoned lawn", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 35 }, { x: 0, y: 35 }],
        L: 70, W: 35, sqft: 2450, avgW: 35,
        family: "rotor", rotorNoz: "b40",
        layout: "manual",
        manualHeads: [
          // Zone numbers deliberately non-contiguous (4 and 9) so the
          // compaction to 0,1 is exercised.
          { x: 10, y: 10, arc: 360, dir: 0, noz: "b40", zone: 4 },
          { x: 20, y: 10, arc: 360, dir: 0, noz: "b40", zone: 4 },
          { x: 30, y: 10, arc: 360, dir: 0, noz: "b40", zone: 9 },
          // Left on Auto — packs into zones after the hand-picked ones.
          { x: 40, y: 25, arc: 180, dir: 0, noz: "b20" },
          { x: 50, y: 25, arc: 180, dir: 0, noz: "b20" },
          { x: 60, y: 25, arc: 180, dir: 0, noz: "b20" }
        ]
      }
    ]
  },

  // ── 6. Manual overrides: free arcs + reduced radius ────────────────
  //
  // Arcs are free-form, so the BOM buckets them (<=90 / <=180 / <=270 /
  // else 360) to pick a nozzle. A 137-degree head must land in a bucket or
  // it falls out of the parts list and out of the material cost. Radius is
  // reduced per head; flow deliberately is NOT.
  {
    id: "manual-override-free-arcs",
    why: "Manual overrides: free arcs bucket to the SAME thresholds the BOM orders by; per-head radius reduction must not change flow.",
    inputs: { ceiling: 7.8, spacingFactor: 1 },
    areas: [
      { aid: "a_free0001", name: "Odd-shaped front", mode: "custom", shapeKind: "poly",
        poly: clone(L_LAWN), L: 46, W: 40, sqft: 1552, avgW: 40,
        family: "spray", sprayBody: "b6", spraySeries: "s15",
        layout: "manual",
        manualHeads: [
          { x: 4,  y: 4,  arc: 137, dir: 0, noz: "s15", rPct: 0.8 },
          { x: 4,  y: 36, arc: 225, dir: 0, noz: "s15" },
          { x: 42, y: 4,  arc: 90,  dir: 0, noz: "s12" },
          { x: 42, y: 18, arc: 271, dir: 0, noz: "s12" },
          { x: 10, y: 20, arc: 360, dir: 0, noz: "s15", rPct: 0.65 },
          { x: 30, y: 12, arc: 180, dir: 0, noz: "s10" }
        ]
      }
    ]
  },

  // ── 7. Mixed irrigation types in one design ────────────────────────
  //
  // Rotor, MP, spray, strip, drip-with-trees and a trees-only zone
  // together. Each family reaches a different branch of plan() and a
  // different set of BOM lines; running them side by side is what catches
  // a branch that only works alone.
  {
    id: "mixed-irrigation-types",
    why: "Mixed irrigation types: every family in one design, so per-family BOM lines and the shared valve/box/wire maths are exercised together.",
    inputs: { ceiling: 7.8, spacingFactor: 1 },
    areas: [
      { aid: "a_mixrot01", name: "Rotor lawn", mode: "rect", L: 60, W: 40, sqft: 2400, avgW: 40,
        family: "rotor", rotorNoz: "b20" },
      { aid: "a_mixmp002", name: "MP lawn", mode: "rect", L: 30, W: 18, sqft: 540, avgW: 18,
        family: "mp", mpNoz: "mp3000" },
      { aid: "a_mixspr03", name: "Spray lawn", mode: "sqft", L: 40, W: 30, sqft: 900, avgW: 20,
        family: "spray", sprayBody: "b12", spraySeries: "s15" },
      { aid: "a_mixstr04", name: "Curb strip", mode: "rect", L: 44, W: 4, sqft: 176, avgW: 4,
        family: "strip", stripNoz: "est", stripBody: "b4" },
      { aid: "a_mixdrp05", name: "Foundation bed", mode: "custom", shapeKind: "poly",
        poly: clone(CURVED_BED), L: 22, W: 17, sqft: 260, avgW: 17,
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "auto",
        trees: [
          { x: 5,  y: 6, type: "ring", dia: 4 },
          { x: 14, y: 9, type: "rws" }
        ] },
      { aid: "a_mixtre06", name: "Boulevard trees", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 8 }, { x: 0, y: 8 }],
        L: 90, W: 8, sqft: 720, avgW: 8,
        family: "trees", dripProduct: "ld08", overagePct: 15,
        trees: [
          { x: 8,  y: 4, type: "ring", dia: 5 },
          { x: 28, y: 4, type: "ring", dia: 6 },
          { x: 48, y: 4, type: "rws" },
          { x: 68, y: 4, type: "rws" },
          { x: 86, y: 4, type: "ring", dia: 3 }
        ] }
    ]
  },

  // ── 8. Shared drip valve, default (one valve, chained lateral) ──────
  //
  // Twelve traced beds used to become twelve valves. Grouped, they pack
  // onto as few valves as the ceiling allows — but each bed KEEPS its own
  // pressure regulator. Getting that wrong under-specs the install while
  // the quote gets cheaper, which is the worst direction for the error to
  // run, so the regulator count is exactly what this fixture watches.
  {
    id: "drip-valve-group-shared",
    why: "Zone splitting across areas: grouped drip beds share valves, but every bed keeps its own pressure regulator.",
    inputs: { ceiling: 7.8, spacingFactor: 1 },
    areas: [
      { aid: "a_bedA0001", name: "Bed A", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 10 }, { x: 0, y: 10 }],
        L: 24, W: 10, sqft: 240, avgW: 10, valveGroup: "Drip A",
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "auto" },
      { aid: "a_bedB0002", name: "Bed B", mode: "custom", shapeKind: "poly",
        poly: [{ x: 40, y: 0 }, { x: 62, y: 0 }, { x: 62, y: 12 }, { x: 40, y: 12 }],
        L: 22, W: 12, sqft: 264, avgW: 12, valveGroup: "Drip A",
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "auto" },
      { aid: "a_bedC0003", name: "Bed C", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 44 }, { x: 0, y: 44 }],
        L: 30, W: 14, sqft: 420, avgW: 14, valveGroup: "Drip A",
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 12, dripDir: "h" },
      { aid: "a_bedD0004", name: "Bed D (own valve)", mode: "custom", shapeKind: "poly",
        poly: [{ x: 50, y: 30 }, { x: 74, y: 30 }, { x: 74, y: 40 }, { x: 50, y: 40 }],
        L: 24, W: 10, sqft: 240, avgW: 10,
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "v" }
    ]
  },

  // ── 9. Shared drip valve in 'station' mode, boxed ───────────────────
  //
  // One valve per VALVE BOX, all landing on one controller station. Beds
  // pinned to different boxes get their own valve there. Same station
  // count, same quote line, MORE valves in the material list — so the
  // valve/box/wire arithmetic has to tell stations and valves apart.
  {
    id: "drip-valve-group-station-mode",
    why: "One station, several valves: boxed drip group must keep the station count while raising the valve count.",
    inputs: { ceiling: 12.0, spacingFactor: 1 },
    valveGroupModes: { "Drip B": "station" },
    areas: [
      { aid: "a_stnA0001", name: "Courtyard bed", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 26, y: 0 }, { x: 26, y: 12 }, { x: 0, y: 12 }],
        L: 26, W: 12, sqft: 312, avgW: 12, valveGroup: "Drip B",
        planRef: { pageId: "pg1" },
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "auto" },
      { aid: "a_stnB0002", name: "Entry bed", mode: "custom", shapeKind: "poly",
        poly: [{ x: 4, y: 20 }, { x: 24, y: 20 }, { x: 24, y: 30 }, { x: 4, y: 30 }],
        L: 20, W: 10, sqft: 200, avgW: 10, valveGroup: "Drip B",
        planRef: { pageId: "pg1" },
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "auto" },
      { aid: "a_stnC0003", name: "Far bed (other box)", mode: "custom", shapeKind: "poly",
        poly: [{ x: 90, y: 0 }, { x: 112, y: 0 }, { x: 112, y: 11 }, { x: 90, y: 11 }],
        L: 22, W: 11, sqft: 242, avgW: 11, valveGroup: "Drip B",
        planRef: { pageId: "pg1" },
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "auto" }
    ],
    routing: {
      pg1: {
        poc: { x: 0, y: 0 },
        main: [],
        // Two boxes, far apart. Nearest-box assignment puts the two close
        // beds on m1 and the far bed on m2 — one station, two valves.
        manifolds: [
          { id: "m_box00001", x: 10, y: 15 },
          { id: "m_box00002", x: 100, y: 6 }
        ],
        pins: {},
        splits: {}
      }
    }
  },

  // ── 10. The driveway split: one station, two valves ─────────────────
  //
  // A line drawn across the sheet sorts the heads onto side A and side B.
  // Both valves open together, so it is ONE station and one quote line,
  // but TWO valves, two laterals and one more conductor. The two halves
  // must add back up to the station's GPM.
  {
    id: "driveway-valve-split",
    why: "Zone splitting: a split zone is two valves on one station; the halves must sum back to the station GPM.",
    inputs: { ceiling: 20.0, spacingFactor: 1 },
    areas: [
      { aid: "a_split001", name: "Front lawn (split by drive)", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 30 }, { x: 0, y: 30 }],
        L: 80, W: 30, sqft: 2400, avgW: 30,
        planRef: { pageId: "pg1" },
        family: "rotor", rotorNoz: "b20",
        layout: "manual",
        manualHeads: [
          { x: 8,  y: 8,  arc: 90,  dir: 0, noz: "b20" },
          { x: 8,  y: 22, arc: 90,  dir: 0, noz: "b20" },
          { x: 24, y: 15, arc: 360, dir: 0, noz: "b20" },
          { x: 56, y: 15, arc: 360, dir: 0, noz: "b20" },
          { x: 72, y: 8,  arc: 90,  dir: 0, noz: "b20" },
          { x: 72, y: 22, arc: 90,  dir: 0, noz: "b20" }
        ] }
    ],
    routing: {
      pg1: {
        poc: { x: 0, y: 0 },
        main: [],
        manifolds: [
          { id: "m_splitA01", x: 6, y: 15 },
          { id: "m_splitB01", x: 76, y: 15 }
        ],
        pins: {},
        // A vertical line at x = 40 — the driveway. Zone key is
        // 'z:<aid>:<local zone>', which is why aid is pinned above.
        //
        // shareStation:true says what this fixture has always MEANT. It was
        // written, and the golden master captured, while the builder could
        // only wire a split's two valves to one controller terminal — the
        // flag did not exist because there was no other answer. Version 9
        // makes the answer explicit and defaults a NEW split the other way,
        // so a flagless split here would silently become two stations and
        // the golden master would "fail" over a fixture that never changed
        // its mind. Writing the old answer down is the same migration
        // restoreRouting() performs on every real version-8 design.
        splits: { "z:a_split001:0": { ax: 40, ay: -10, bx: 40, by: 40, shareStation: true } }
      }
    }
  },

  // ── 11. Drip roll rounding: the 200 ft rule ─────────────────────────
  //
  // Drip tube is bought for the WHOLE system. Bulk comes in 500 ft rolls;
  // a leftover of 200 ft or more rounds UP to another 500 rather than
  // taking a 250. Three beds sized to land the remainder just over that
  // line, so a change to the rule shows up as a whole roll.
  {
    id: "drip-roll-rounding-200ft-rule",
    why: "Rounding + BOM quantities: system-wide drip footage rolls up by Patrick's 200 ft rule, not per bed.",
    inputs: { ceiling: 7.8, spacingFactor: 1 },
    areas: [
      { aid: "a_roll0001", name: "Long bed 1", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 30 }, { x: 0, y: 30 }],
        L: 120, W: 30, sqft: 3600, avgW: 30,
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "h" },
      { aid: "a_roll0002", name: "Long bed 2", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 40 }, { x: 100, y: 40 }, { x: 100, y: 22 }, { x: 0, y: 22 }],
        L: 100, W: 18, sqft: 1800, avgW: 18,
        family: "drip", dripProduct: "xf09", overagePct: 0, dripRowIn: 18, dripDir: "h" },
      { aid: "a_roll0003", name: "Short top-up bed", mode: "rect", L: 20, W: 6, sqft: 120, avgW: 6,
        family: "drip", dripProduct: "ld08", overagePct: 10, dripRowIn: 18, dripDir: "auto" }
    ]
  },

  // ── 11b. Drip roll rounding: the other side of the 200 ft rule ──────
  //
  // Same rule, remainder UNDER the line. 3,600 ft is seven 500 ft rolls
  // and 100 ft left, and 100 is a small top-up — so it takes a 250 ft roll
  // rather than rounding up to an eighth 500. Both sides of a threshold
  // have to be pinned or only one of them is actually tested.
  {
    id: "drip-roll-rounding-under-200ft",
    why: "Rounding + BOM quantities: a leftover under 200 ft takes a 250 ft roll instead of rounding up to another 500.",
    inputs: { ceiling: 7.8, spacingFactor: 1 },
    areas: [
      { aid: "a_undr0001", name: "Long planter", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 180, y: 0 }, { x: 180, y: 30 }, { x: 0, y: 30 }],
        L: 180, W: 30, sqft: 5400, avgW: 30,
        family: "drip", dripProduct: "xf09", overagePct: 0, dripRowIn: 18, dripDir: "h" }
    ]
  },

  // ── 12. Sector and circle shapes ────────────────────────────────────
  //
  // A quarter-circle lawn wrapping a corner and a round bed. Area comes
  // from the true sector/circle formula, not the bounding box, and the
  // drip run direction goes 'arc' on a sector — concentric, following the
  // curve.
  {
    id: "sector-and-circle-shapes",
    why: "Geometry boundary: sector/circle area uses the real formula; a sector's drip runs concentric.",
    inputs: { ceiling: 7.8, spacingFactor: 1 },
    areas: [
      { aid: "a_sect0001", name: "Corner sweep", mode: "custom", shapeKind: "sector",
        arc: { cx: 20, cy: 20, r: 28, a0: 0, sweep: 90 },
        L: 28, W: 28, sqft: 615, avgW: 28,
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "auto" },
      { aid: "a_circ0002", name: "Round bed", mode: "custom", shapeKind: "circle",
        circle: { cx: 60, cy: 20, r: 9 },
        L: 18, W: 18, sqft: 254, avgW: 18,
        family: "spray", sprayBody: "b4", spraySeries: "s10" }
    ]
  },

  // ── 13. Spacing factor + nothing drawn yet ──────────────────────────
  //
  // A tighter spacing factor changes head COUNT, which changes every
  // downstream number. And a custom area with no outline yet must fall
  // out of the plan entirely — noShape, contributing nothing to the BOM
  // — rather than quietly counting as a zone.
  {
    id: "spacing-factor-and-no-shape",
    why: "Spacing factor drives head count end to end; an undrawn custom area must contribute nothing.",
    inputs: { ceiling: 7.8, spacingFactor: 0.8 },
    areas: [
      { aid: "a_tight001", name: "Tight-spaced lawn", mode: "rect", L: 50, W: 34, sqft: 1700, avgW: 34,
        family: "rotor", rotorNoz: "b15" },
      { aid: "a_blank002", name: "Not drawn yet", mode: "custom",
        L: 1, W: 1, sqft: 0, avgW: 1, family: "spray", sprayBody: "b4", spraySeries: "s12" }
    ]
  },

  // ── 14. Controller sizing steps, and the big commercial job ─────────
  //
  // Station count picks the controller: <=4, <=6, <=8, <=14, then the
  // modular HPC plus expansion modules. This design is sized to cross into
  // the modular branch, which is also where the wire count, the box count
  // and the per-valve manifold kit all multiply up.
  {
    id: "commercial-large-station-count",
    why: "BOM quantities + pricing at scale: crosses into the modular controller branch, multiplies valve/box/wire/fitting counts.",
    inputs: { ceiling: 6.0, spacingFactor: 1 },
    areas: [
      { aid: "a_com00001", name: "Lot frontage", mode: "rect", L: 180, W: 22, sqft: 3960, avgW: 22,
        family: "rotor", rotorNoz: "b40" },
      { aid: "a_com00002", name: "Drive island A", mode: "rect", L: 36, W: 12, sqft: 432, avgW: 12,
        family: "mp", mpNoz: "mp2000" },
      { aid: "a_com00003", name: "Drive island B", mode: "rect", L: 36, W: 12, sqft: 432, avgW: 12,
        family: "mp", mpNoz: "mp2000" },
      { aid: "a_com00004", name: "Patio surround", mode: "sqft", L: 60, W: 24, sqft: 1440, avgW: 24,
        family: "spray", sprayBody: "b6", spraySeries: "s12" },
      { aid: "a_com00005", name: "Planter run", mode: "custom", shapeKind: "poly",
        poly: [{ x: 0, y: 0 }, { x: 140, y: 0 }, { x: 140, y: 6 }, { x: 0, y: 6 }],
        L: 140, W: 6, sqft: 840, avgW: 6,
        family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 12, dripDir: "h",
        trees: [
          { x: 20,  y: 3, type: "rws" },
          { x: 60,  y: 3, type: "rws" },
          { x: 100, y: 3, type: "rws" }
        ] }
    ]
  },

  // ── 15. Legacy v1 design, migrated on load ──────────────────────────
  //
  // Old saved designs carry a v1 `head` key and stray `r`/`g` fields.
  // ensureArea() migrates them to a family + nozzle and drops the legacy
  // fields. A migration that drifts silently re-prices an archived job.
  {
    id: "legacy-v1-design-migration",
    why: "Legacy migration: a v1 saved design must still resolve to the same family, nozzle and numbers.",
    inputs: { ceiling: 7.8, spacingFactor: 1 },
    areas: [
      { aid: "a_leg00001", name: "Old front", mode: "rect", L: 40, W: 30, sqft: 1200, avgW: 30,
        head: "pgp4", r: 35, g: 4.1 },
      { aid: "a_leg00002", name: "Old strip", mode: "rect", L: 50, W: 4, sqft: 200, avgW: 4,
        head: "cst", r: 15, g: 1.21 },
      { aid: "a_leg00003", name: "Old bed", mode: "rect", L: 18, W: 8, sqft: 144, avgW: 8,
        head: "drip", r: 0, g: 0 },
      { aid: "a_leg00004", name: "Old MP lawn", mode: "rect", L: 28, W: 20, sqft: 560, avgW: 20,
        head: "mp2000", r: 13, g: 0.46 }
    ]
  }
];

export const fixtureById = new Map(fixtures.map((f) => [f.id, f]));
