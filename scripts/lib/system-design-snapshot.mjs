// scripts/lib/system-design-snapshot.mjs
//
// Normalization and comparison for the System Builder golden master.
//
// TWO RULES, AND THEY PULL IN OPPOSITE DIRECTIONS
//
// 1. Money is compared EXACTLY, to the cent. Every price in this engine is
//    an integer number of cents, so there is no rounding to forgive. A
//    one-cent drift is a real difference and the comparison says so.
//
// 2. Order is normalized WHERE IT IS NOT MEANINGFUL. Two engines that
//    produce the same bill of materials in a different order produce the
//    same bill of materials.
//
// Rule 2 is the dangerous one: normalize an ordering that DOES carry
// meaning and the safety net stops catching the thing it was built for. So
// the list below is explicit about which orders are meaningful and stay
// untouched:
//
//    heads[]      MEANINGFUL — spatial. The auto layout walks the shape and
//                 a hand-placed layout is in the order it was drawn. Zone
//                 boundaries are cuts in this sequence, so reordering it
//                 would silently re-zone the design. Left alone.
//    zones[]      MEANINGFUL — station numbers are assigned by position in
//                 applyValveSplits(), and a split zone's A half must come
//                 before its B half. Left alone.
//    areas[]      MEANINGFUL — the design's own order; zone keys and valve
//                 box assignments are built from it. Left alone.
//    bom.lines[]  NOT meaningful — a set of parts with quantities. Catalog
//                 lines are already sorted by SKU, but the non-stocked
//                 lines are appended in encounter order, which is an
//                 accident of which area came first. Sorted.
//    object keys  NOT meaningful. Sorted everywhere, so { zones, gpm } and
//                 { gpm, zones } compare equal.
//
// Nothing is rounded. The extracted engine runs the same arithmetic in the
// same order on the same IEEE-754 doubles, so it should reproduce every
// float bit for bit. Comparing exactly is what makes that claim testable —
// an epsilon would quietly absorb a reordered sum.

/** JSON with object keys sorted at every depth; array order preserved. */
export function stableStringify(value, indent = 2) {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/**
 * Put a raw capture into comparison form: sort the collections whose order
 * is an accident, leave the ones whose order is a decision.
 */
export function normalizeSnapshot(raw) {
  const out = JSON.parse(JSON.stringify(raw));
  for (const fx of out.fixtures || []) {
    if (fx.bom && Array.isArray(fx.bom.lines)) {
      fx.bom.lines.sort(
        (a, b) =>
          String(a.sku).localeCompare(String(b.sku)) ||
          String(a.desc).localeCompare(String(b.desc)) ||
          (a.qty - b.qty)
      );
    }
  }
  return sortKeys(out);
}

/**
 * Field-by-field difference between two normalized snapshots, as a flat
 * list of { path, expected, actual }. A path is what you would type to
 * reach the value, so a failure names the exact number that moved.
 */
export function diffSnapshots(expected, actual) {
  const diffs = [];
  walk(expected, actual, "", diffs);
  return diffs;
}

function walk(exp, act, path, diffs) {
  if (Object.is(exp, act)) return;

  const expIsObj = exp && typeof exp === "object";
  const actIsObj = act && typeof act === "object";

  if (!expIsObj || !actIsObj || Array.isArray(exp) !== Array.isArray(act)) {
    diffs.push({ path: path || "(root)", expected: exp, actual: act });
    return;
  }

  if (Array.isArray(exp)) {
    if (exp.length !== act.length) {
      diffs.push({ path: `${path}.length`, expected: exp.length, actual: act.length });
    }
    const n = Math.max(exp.length, act.length);
    for (let i = 0; i < n; i++) walk(exp[i], act[i], `${path}[${i}]`, diffs);
    return;
  }

  for (const k of new Set([...Object.keys(exp), ...Object.keys(act)])) {
    walk(exp[k], act[k], path ? `${path}.${k}` : k, diffs);
  }
}

/** Every money field in a snapshot, so the summary can report them apart. */
export function moneyFields(diffs) {
  return diffs.filter((d) => /cents|priceCents|subtotalCents/i.test(d.path));
}
