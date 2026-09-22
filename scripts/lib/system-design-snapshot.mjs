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

/**
 * Split a diff list into differences that matter and differences that are
 * the JavaScript runtime rather than the code.
 *
 * WHY THIS EXISTS, AND WHY IT IS DRAWN THIS TIGHT
 *
 * Math.sin and Math.cos are allowed by the language spec to be
 * implementation-defined to within an ulp, and they are: for the 33rd
 * vertex of a 48-sided circle, Chromium's V8 says -0.8660254037844384 and
 * Node's says -0.8660254037844385. Same source, same input, different
 * last bit. Nothing about the engine changed.
 *
 * That is a real and boring fact about running the same geometry in two
 * runtimes, and it must not be allowed to become a place where genuine
 * differences hide. So the allowance is deliberately narrow, and every
 * difference it swallows is still REPORTED by path:
 *
 *   - both sides must be finite numbers;
 *   - the recorded value must NOT be a whole number. Every count in this
 *     engine — valves, heads, stations, quantities, zone indices, cents —
 *     is an integer, so an integer that moved is always a real difference;
 *   - nothing on a money path, whatever its value;
 *   - and the gap must be under a billionth, both absolutely and relative
 *     to the value.
 *
 * A billionth rather than a few ulp because these coordinates are
 * SUBTRACTED — a head's position is its sheet coordinate minus the area's
 * origin — and subtracting two nearby numbers amplifies the relative error
 * of each. An ulp of drift at 12.2 ft becomes seven ulp at 1.2 ft. The
 * absolute size of the drift is the honest measure, and it is what the
 * bound is set on.
 *
 * A billionth of a foot is a nanometre. Nothing in this engine is
 * specified anywhere near that finely: the smallest deliberate quantity in
 * it is the packer's thousandth-of-a-GPM epsilon, six orders of magnitude
 * larger, and every price is a whole cent. A formula that actually changed
 * cannot hide under this.
 *
 * The authoritative comparison is still the exact one: the extracted
 * engine is run in the SAME runtime the golden master was recorded in, and
 * there it has to match bit for bit with no allowance at all.
 */
export function classifyDiffs(diffs) {
  const real = [];
  const runtimeFloat = [];
  const declaredNew = [];
  for (const d of diffs) {
    if (isRuntimeFloatNoise(d)) runtimeFloat.push(d);
    else if (isDeclaredNewField(d)) declaredNew.push(d);
    else real.push(d);
  }
  return { real, runtimeFloat, declaredNew };
}

/**
 * Fields the engine did not used to emit at all, declared here by name.
 *
 * WHY THIS EXISTS, AND WHY IT IS DRAWN THIS TIGHT
 *
 * A golden master records what the old code SAID. Code that answers every
 * old question identically and also says one more thing has not changed any
 * answer — but a field-for-field diff cannot tell that apart from a number
 * moving, so it fails, and the usual reflex is to re-capture the golden
 * master. That is the one thing that must never happen: re-capturing
 * replaces the record of the old behaviour with the new behaviour and the
 * net stops being a net.
 *
 * So a new field is DECLARED instead. The bar is deliberately high:
 *
 *   - the golden master must have no value at that path at all. A field
 *     that existed and changed its value is never in this category, and
 *     neither is one that disappeared;
 *   - the LAST segment of the path must be one of the names listed below,
 *     written out one at a time. There is no pattern and no wildcard;
 *   - nothing on a money path, whatever its name.
 *
 * Every difference this swallows is still reported by path, exactly like
 * the runtime-float allowance above. Adding a name here is a deliberate
 * claim that the field is new, additive, and changes no existing answer —
 * and the rest of the suite still has to pass with the claim in place.
 */
const DECLARED_NEW_FIELDS = [
  // 2026-09-22, version 9. A split zone's two halves now carry the
  // shared-station decision that produced their station numbers, so the
  // page can show the valve toggle and name a design still carrying the
  // old assumption. Both are descriptive: applyValveSplits() reads the
  // decision off the split, not off these.
  "shareStation",
  "legacyShare"
];

function isDeclaredNewField(d) {
  const { path, expected } = d;
  if (/cents/i.test(path)) return false;
  if (expected !== undefined) return false;
  const last = String(path).split(".").pop();
  return DECLARED_NEW_FIELDS.includes(last);
}

function isRuntimeFloatNoise(d) {
  const { path, expected, actual } = d;
  if (/cents/i.test(path)) return false;
  if (typeof expected !== "number" || typeof actual !== "number") return false;
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  if (Number.isInteger(expected) || Number.isInteger(actual)) return false;
  const gap = Math.abs(expected - actual);
  const scale = Math.max(1, Math.abs(expected), Math.abs(actual));
  return gap <= RUNTIME_FLOAT_TOLERANCE && gap <= RUNTIME_FLOAT_TOLERANCE * scale;
}

// A nanometre, a billionth of a GPM, a billionth of a cent. See above for
// why the bound is absolute rather than counted in ulp.
const RUNTIME_FLOAT_TOLERANCE = 1e-9;
