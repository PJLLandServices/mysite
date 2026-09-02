// Town centroids — the geography filter's parachute.
//
// Patrick, on seeing an Erin address offered every route day because one
// geocode failed: "we cannot have this fail." The geography filter is
// fail-soft by design (an address it can't place skips the filter), and
// that is the right call for a single flaky lookup — but it means a
// missing API key, a Google outage, or one odd address string turns the
// filter OFF for that customer, silently, at the exact moment it has a
// job to do.
//
// This table is the middle ground. When Google can't resolve an address
// (or there is no key at all), we look for a TOWN we recognize in the
// address text and answer with that town's approximate centre. At the
// scale the filter works — "does inserting this stop cost more than ~15
// minutes of extra driving?" — a town centre is plenty: Erin's centre is
// ~55 km from Newmarket's routes, and being 2 km off inside Erin changes
// nothing. The filter stays ON with a close-enough answer instead of
// switching off with none.
//
// Deliberate limits:
//   - Coordinates are approximate town centres, maintained by hand.
//     They are for DRIVE-TIME COMPARISON ONLY and are never good enough
//     to persist: geocode() returns them with ok:false and
//     source "town-centroid", and every path that writes coordinates to
//     a record requires ok:true (see geocodeForRecord in server.js) —
//     so a centroid can steer availability but can never pin a property.
//   - An address whose town we don't recognize still falls back to the
//     old behavior (filter skipped, said out loud on the probe screen).
//     The table covers PJL's service area and the surrounding belt a
//     stray booking attempt realistically comes from.
//
// Tested by scripts/test-geocode-fallback.mjs.

// name (as matched, lowercase) -> [lat, lng, display name]
// Multi-word names must appear before any word they contain would match
// — lookup() sorts by length, so "richmond hill" wins over any "hill".
const TOWNS = {
  // ---- Service area and near belt ----
  "newmarket": [44.056, -79.462, "Newmarket"],
  "aurora": [44.006, -79.467, "Aurora"],
  "east gwillimbury": [44.108, -79.439, "East Gwillimbury"],
  "holland landing": [44.093, -79.492, "Holland Landing"],
  "sharon": [44.103, -79.435, "Sharon"],
  "queensville": [44.120, -79.427, "Queensville"],
  "mount albert": [44.135, -79.310, "Mount Albert"],
  "keswick": [44.240, -79.462, "Keswick"],
  "sutton": [44.303, -79.365, "Sutton"],
  "georgina": [44.296, -79.435, "Georgina"],
  "bradford": [44.114, -79.561, "Bradford"],
  "bradford west gwillimbury": [44.114, -79.561, "Bradford"],
  "bond head": [44.100, -79.620, "Bond Head"],
  "innisfil": [44.300, -79.600, "Innisfil"],
  "churchill": [44.310, -79.550, "Churchill"],
  "barrie": [44.389, -79.690, "Barrie"],
  "king city": [43.925, -79.526, "King City"],
  "nobleton": [43.905, -79.652, "Nobleton"],
  "schomberg": [43.995, -79.683, "Schomberg"],
  "kettleby": [43.985, -79.555, "Kettleby"],
  "richmond hill": [43.883, -79.440, "Richmond Hill"],
  "oak ridges": [43.945, -79.455, "Oak Ridges"],
  "stouffville": [43.970, -79.245, "Stouffville"],
  "whitchurch-stouffville": [43.970, -79.245, "Stouffville"],
  "markham": [43.870, -79.263, "Markham"],
  "unionville": [43.865, -79.310, "Unionville"],
  "thornhill": [43.815, -79.420, "Thornhill"],
  "vaughan": [43.837, -79.500, "Vaughan"],
  "maple": [43.855, -79.510, "Maple"],
  "woodbridge": [43.780, -79.600, "Woodbridge"],
  "concord": [43.800, -79.480, "Concord"],
  // ---- Where stray attempts realistically come from ----
  "toronto": [43.651, -79.383, "Toronto"],
  "north york": [43.770, -79.410, "North York"],
  "scarborough": [43.770, -79.250, "Scarborough"],
  "etobicoke": [43.650, -79.550, "Etobicoke"],
  "ajax": [43.850, -79.020, "Ajax"],
  "pickering": [43.840, -79.090, "Pickering"],
  "whitby": [43.880, -78.940, "Whitby"],
  "oshawa": [43.900, -78.860, "Oshawa"],
  "uxbridge": [44.110, -79.120, "Uxbridge"],
  "port perry": [44.100, -78.940, "Port Perry"],
  "mississauga": [43.590, -79.640, "Mississauga"],
  "brampton": [43.730, -79.760, "Brampton"],
  "caledon": [43.870, -79.860, "Caledon"],
  "bolton": [43.880, -79.730, "Bolton"],
  "orangeville": [43.920, -80.090, "Orangeville"],
  "erin": [43.770, -80.070, "Erin"],
  "georgetown": [43.650, -79.930, "Georgetown"],
  "milton": [43.520, -79.880, "Milton"],
  "oakville": [43.450, -79.680, "Oakville"],
  "burlington": [43.330, -79.800, "Burlington"],
  "guelph": [43.545, -80.250, "Guelph"],
  "hamilton": [43.256, -79.870, "Hamilton"],
  "alliston": [44.150, -79.870, "Alliston"],
  "tottenham": [44.020, -79.800, "Tottenham"],
  "beeton": [44.080, -79.780, "Beeton"],
  "angus": [44.320, -79.880, "Angus"],
  "orillia": [44.610, -79.420, "Orillia"],
  "midland": [44.750, -79.890, "Midland"],
  "collingwood": [44.500, -80.220, "Collingwood"],
  "wasaga beach": [44.520, -80.020, "Wasaga Beach"]
};

// Longest names first, so "bradford west gwillimbury" is tried before
// "bradford", and "north york" before any bare "york" ever added.
const NAMES_BY_LENGTH = Object.keys(TOWNS).sort((a, b) => b.length - a.length);

// Find a known town in free-text address. Whole-word match against the
// normalized string, so "Erindale Rd, Mississauga" resolves to
// Mississauga (the street's "erin" is inside a word and doesn't match).
function townFromText(address) {
  const text = String(address || "").toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const padded = ` ${text} `;
  for (const name of NAMES_BY_LENGTH) {
    if (padded.includes(` ${name} `)) return name;
  }
  return null;
}

// lookup("9 Erinville Dr, Erin, ON N0B 1T0") ->
//   { lat, lng, formattedAddress, source: "town-centroid", town }
// or null when no known town appears in the text.
function lookup(address) {
  const name = townFromText(address);
  if (!name) return null;
  const [lat, lng, display] = TOWNS[name];
  return {
    lat,
    lng,
    formattedAddress: `${display}, ON (town centre — approximate)`,
    source: "town-centroid",
    town: display
  };
}

module.exports = { lookup, townFromText, TOWNS };
