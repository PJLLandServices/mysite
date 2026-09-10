// Route origin — the yard. Where the truck leaves from and returns to.
//
// WHY THIS IS ITS OWN MODULE. geocode.js exports PJL_BASE, and PJL_BASE is
// not the yard: it is Newmarket town centre, written as the FALLBACK for
// customer addresses that will not geocode. Its whole job is to be a
// deliberately vague point meaning "we do not know where this is".
//
// The route optimiser then adopted it as the start-and-end anchor, because
// it was the only base-shaped constant in the codebase. Nobody asked
// whether it was an address. It is not: `formattedAddress: "Newmarket, ON,
// Canada"`. Measured from that dot, 89 Prospect St is the nearest stop on
// R1 at 0.67 km and the Creebridge pair are 3.5 km away — while from the
// real yard on Cenotaph Blvd the order is reversed, which is exactly what
// Patrick said when he looked at the route and knew it was wrong.
//
// So the two jobs are now separate, and must stay separate:
//
//   PJL_BASE (geocode.js)   fallback for an address we cannot resolve.
//                           Unchanged. A vague town point is the RIGHT
//                           answer to "where is this?" when we don't know.
//   routeOrigin() (here)    the actual yard. Anchors every route day, and
//                           feeds the added-drive figure the geography
//                           filter accepts or refuses customers on.
//
// AN ADDRESS, NOT COORDINATES. The yard is configured as a street address
// and resolved through the same geocoder as everything else. Hardcoding a
// latitude and longitude would mean someone typing numbers nobody can
// check by eye — which is how a town centroid survived this long. An
// address is legible: it is either right or obviously wrong.
//
// Override with PJL_ROUTE_ORIGIN in the environment to move the yard
// without a deploy.

const { geocode, PJL_BASE } = require("./geocode");

const DEFAULT_ROUTE_ORIGIN_ADDRESS = "1118 Cenotaph Blvd, Newmarket, ON L3X 0A5, Canada";

function routeOriginAddress() {
  const configured = String(process.env.PJL_ROUTE_ORIGIN || "").trim();
  return configured || DEFAULT_ROUTE_ORIGIN_ADDRESS;
}

// Resolved once per process. The geocoder has its own disk cache, so this
// memo is only about not re-entering it on every route day.
let memo = null;
let memoAddress = null;

// Returns { lat, lng, formattedAddress, source, resolved, address }.
//
// FAILS SOFT, LOUDLY. If the yard will not geocode we fall back to the
// town centroid and say so on the console — a slightly worse anchor is
// survivable, a crashed re-sequence is not. `resolved: false` travels with
// the result so the plan screen can show that routes are anchored to a
// guess rather than quietly presenting them as authoritative.
async function routeOrigin() {
  const address = routeOriginAddress();
  if (memo && memoAddress === address) return memo;

  let result;
  try {
    const geo = await geocode(address);
    const usable = geo.ok === true && geo.coords && geo.coords.lat != null
      && geo.coords.source !== "pjl-base";
    if (usable) {
      result = { ...geo.coords, resolved: true, address };
    } else {
      console.warn(`[route-origin] could not geocode the yard (${address}) — `
        + "routes are anchored to the Newmarket town centroid instead.");
      result = { ...PJL_BASE, resolved: false, address };
    }
  } catch (err) {
    console.warn("[route-origin] geocode threw, using the town centroid:", err?.message);
    result = { ...PJL_BASE, resolved: false, address };
  }

  memo = result;
  memoAddress = address;
  return result;
}

// Test seam — the memo would otherwise outlive an env change.
function resetRouteOriginCache() { memo = null; memoAddress = null; }

module.exports = {
  routeOrigin,
  routeOriginAddress,
  resetRouteOriginCache,
  DEFAULT_ROUTE_ORIGIN_ADDRESS
};
