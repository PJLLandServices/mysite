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

/* One engine pass over a saved design. Everything this module reports —
 * the three counts and the station-by-station readout — comes out of THIS
 * function, because two passes are two chances to disagree, which is the
 * mistake `areas.length` was.
 *
 * @returns {{zones:Array, areaCount:number}|null} null when the blob is
 *          not a design, or when the engine could not run it.
 */
function runEngine(design) {
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
  return zones;
}

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
    const zones = runEngine(design);
    stationCount = E.stationCount(zones);
    valveCount = zones.length;                 // one entry per physical valve
  } catch (_) {
    // Leave stations and valves at zero rather than inventing them from the
    // area count — which is the mistake this module exists to end.
  }
  return { stationCount, valveCount, areaCount };
}

/* Describe a saved design station by station (2026-09-24).
 *
 * Patrick asked to be able to READ a saved plan on a phone while the
 * drawing itself stays a desktop job. This is that reading: the same
 * station list the builder's own master plan draws — from
 * `E.stationZones()`, the engine function the page uses — so what the
 * workspace prints on a phone and what the builder prints on a laptop
 * cannot be two different plans.
 *
 * `valves` is a count and never a repeat of the station: a shared split
 * station says 2, and that is how "12 stations · 16 valves" adds up when
 * you read it line by line.
 *
 * @returns {Array<{station:number,name:string,family:string,valves:number,
 *                  gpm:number,headCount:number,members:string[]}>}
 *          empty when the design has no stations or the engine failed —
 *          never a partial plan dressed up as a whole one.
 */
function describeSystemDesign(design) {
  if (!design || typeof design !== "object" || !Array.isArray(design.areas)) return [];
  try {
    const zones = runEngine(design);
    return E.stationZones(zones).map((s) => ({
      station: (s.station || 0) + 1,          // 1-based: what the controller face says
      name: s.name || "Zone",
      family: s.family || "",
      valves: s.valves || 0,
      gpm: Math.round((s.gpm || 0) * 10) / 10,
      headCount: s.headCount || 0,
      members: Array.isArray(s.members) ? s.members : []
    }));
  } catch (_) {
    return [];
  }
}

module.exports = { countSystemDesign, describeSystemDesign };
