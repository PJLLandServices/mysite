// scripts/fixtures/v8-split-designs.mjs
//
// Version-8 designs containing splits — the shape that must not change.
//
// A version-8 blob was saved under a rule the code could not express: every
// split zone's two valves were wired to ONE controller terminal, because
// that is all applyValveSplits() could do. Those designs were priced,
// proposed, wired and scheduled on that basis. Opening one after the
// shareStation change must therefore move NOTHING — not a station, not a
// proposal line, not the controller, not a run time, not a part.
//
// So these fixtures deliberately carry no `shareStation` anywhere. The
// migration is what has to supply it. A fixture that already had the flag
// would be testing the new code against itself.

const H = (x, y, noz) => ({ x, y, arc: 360, dir: 0, noz });
const lawn = (aid, name, x0, w, h, noz, n) => ({
  aid, name, mode: "custom", shapeKind: "poly", planRef: { pageId: "pg1" },
  poly: [{ x: x0, y: 0 }, { x: x0 + w, y: 0 }, { x: x0 + w, y: h }, { x: x0, y: h }],
  L: w, W: h, sqft: w * h, avgW: h,
  family: "rotor", rotorNoz: noz, layout: "manual",
  manualHeads: Array.from({ length: n }, (_, i) => H(x0 + 3 + i * ((w - 6) / Math.max(n - 1, 1)), h / 2, noz))
});

export const v8WithSplits = {
  version: 8,
  savedAt: "2026-06-14T15:00:00.000Z",
  inputs: { availGPM: "18", psi: "60", supply: "municipal", ceiling: "17.1", spacingFactor: "0.9",
            wcTown: "", wcRun: "20", wcCycles: "3", wcWeeks: "20", wcManualRate: "", wcManualUnit: "m3" },
  waterSupply: { hosebibTested: true, newSupplyRequired: false, flowSensorRequired: false, installDifficulty: 4 },
  bomOverrides: { edits: {}, removed: {}, custom: [] },
  linkedQuoteId: null,
  areas: [
    // Split by a line — heads on both sides.
    // 14 x 1.1 GPM = 15.4 on one station -> 1-1/4" mainline. Separated,
    // each half is ~7.7 and the peak falls to another station, which would
    // drop the suggestion to 1". That is the downgrade the pin prevents.
    lawn("a_front", "Front lawn", 0, 160, 26, "r3", 14),
    // Not split. Kept well under the front lawn so the split zone is the
    // PEAK station — otherwise separating it would not lower peak flow and
    // the mainline assertions below would be vacuous.
    lawn("a_side", "Side lawn", 200, 70, 20, "r3", 7),
    // A second split, so more than one is migrated.
    lawn("a_back", "Back lawn", 300, 140, 30, "r5", 12),
    // Trees split on their trees rather than heads — the other split path.
    { aid: "a_trees", name: "Boulevard trees", mode: "custom", shapeKind: "poly", planRef: { pageId: "pg1" },
      poly: [{ x: 0, y: 60 }, { x: 460, y: 60 }, { x: 460, y: 92 }, { x: 0, y: 92 }],
      L: 460, W: 32, sqft: 14720, avgW: 32,
      family: "trees", dripProduct: "xf09", overagePct: 10,
      trees: Array.from({ length: 6 }, (_, i) => ({ x: 30 + i * 80, y: 76, type: i % 2 ? "rws" : "ring", dia: 4 })) },
    // A boxed drip group, which shares a station for a DIFFERENT reason and
    // must be left completely alone by this change.
    ...Array.from({ length: 4 }, (_, i) => ({
      aid: `a_bed${i}`, name: `Bed ${i + 1}`, mode: "custom", shapeKind: "poly", planRef: { pageId: "pg1" },
      // Small on purpose: four beds on one shared station must stay well
      // under the front lawn, or the drip group becomes the peak and the
      // mainline assertions stop testing the split.
      poly: [{ x: i * 40, y: 100 }, { x: i * 40 + 30, y: 100 }, { x: i * 40 + 30, y: 104 }, { x: i * 40, y: 104 }],
      L: 30, W: 12, sqft: 120, avgW: 12, valveGroup: "Drip A",
      family: "drip", dripProduct: "xf09", overagePct: 10, dripRowIn: 18, dripDir: "auto"
    }))
  ],
  valveGroupModes: { "Drip A": "station" },
  routing: {
    pg1: {
      poc: { x: 240, y: 130 }, main: [],
      manifolds: [{ id: "m_w", x: 20, y: 50 }, { id: "m_e", x: 430, y: 50 }, { id: "m_c", x: 240, y: 118 }],
      pins: {},
      // No shareStation anywhere. The migration has to supply it.
      splits: {
        "z:a_front:0": { ax: 80, ay: -20, bx: 80, by: 50 },
        // Back lawn is TWO area zones (22.8 GPM over a 17.1 ceiling); this line
        // has to fall among zone 0's heads, which end around x=364, or the
        // split quietly does not apply and the fixture covers one case less.
        "z:a_back:0":  { ax: 340, ay: -20, bx: 340, by: 50 },
        "z:a_trees:0": { ax: 230, ay: 50, bx: 230, by: 100 }
      },
      latSize: {}, laterals: {}
    }
  },
  wcRunOverrides: {}
};

/** The same design already migrated and saved once, as version 9. */
export const v9Migrated = JSON.parse(JSON.stringify(v8WithSplits));
v9Migrated.version = 9;
for (const k of Object.keys(v9Migrated.routing.pg1.splits)) {
  v9Migrated.routing.pg1.splits[k].shareStation = true;
  v9Migrated.routing.pg1.splits[k].legacy = true;
}

/** Version 9 with the front lawn deliberately moved to two stations —
 *  Dundalk's correction, in miniature. */
export const v9FrontSeparated = JSON.parse(JSON.stringify(v9Migrated));
v9FrontSeparated.routing.pg1.splits["z:a_front:0"].shareStation = false;
delete v9FrontSeparated.routing.pg1.splits["z:a_front:0"].legacy;
