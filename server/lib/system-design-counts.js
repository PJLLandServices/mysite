"use strict";
/* Stations, valves and areas are THREE DIFFERENT COUNTS.
 *
 * Patrick, on Dundalk: "Controller station: Trees — one programmed output.
 * Physical valves: Trees A and Trees B — two valve layers. Designed area:
 * Trees — one landscape area."
 *
 *   station   one programmed output on the controller. What the proposal
 *             quotes a line for, and what the controller is sized on.
 *   valve     a box, a solenoid and a lateral run. Two valves wired to one
 *             terminal are still two valves and two trenches.
 *   area      one traced landscape area. An area can produce several
 *             valves; grouped drip beds collapse several areas onto one.
 *
 * The project summary used to send `zoneCount: systemDesign.areas.length`
 * and let four readers call it a zone count. It is none of the three: it
 * agrees with the builder only when no area splits and no beds group, and
 * it silently disagreed on every job where either happened.
 *
 * Counting properly means running the design through the same engine the
 * builder runs, so the server and the screen cannot answer differently.
 * That is the point of the engine being a module.
 */
const path = require("path");
const E = require(path.join(__dirname, "..", "sitebuilder-engine.js"));

/**
 * Count a saved systemDesign blob.
 * @returns {{stationCount:number, valveCount:number, areaCount:number}|null}
 *          null when the blob is not a design at all.
 */
function countSystemDesign(design) {
  if (!design || typeof design !== "object" || !Array.isArray(design.areas)) return null;
  const areaCount = design.areas.length;
  // The area count never needs the engine, and must survive it failing: a
  // design the engine chokes on is still a design with areas in it.
  let stationCount = 0, valveCount = 0;
  try {
    const areas = JSON.parse(JSON.stringify(design.areas)).map((a) => E.ensureArea(a));
    const inputs = design.inputs || {};
    const ceiling = parseFloat(inputs.ceiling) || 0;
    const spacingFactor = inputs.spacingFactor;
    // Version 8 and earlier stored no shareStation, and a flagless split
    // means SHARED on those designs. One rule, in the engine, so this
    // agrees with the builder and with the split-zone audit.
    const routing = E.migrateRoutingSplits(design.routing || {}, design.version);
    const plans = areas.map((a) => ({ area: a, plan: E.computePlan(a, { ceiling, spacingFactor }) }));
    const zones = E.computeZonePlan({
      plans, areas, routing,
      valveGroupModes: design.valveGroupModes || {},
      ceiling
    });
    stationCount = E.stationCount(zones);
    valveCount = zones.length;                 // one entry per physical valve
  } catch (_) {
    // Leave stations and valves at zero rather than inventing them from the
    // area count — which is the mistake this module exists to end.
  }
  return { stationCount, valveCount, areaCount };
}

module.exports = { countSystemDesign };
