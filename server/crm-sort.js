// Shared sort helpers for the CRM index pages (customers + properties).
//
// Both indexes want the same three things — alphabetical by name, by town,
// and by most-recent activity — and both want the choice to survive a
// reload. Written once here so the two lists can't drift into ordering the
// same names differently, in the same plain-script style as the bulk-*.js
// helpers this directory already shares.
//
// Loaded as a plain <script> (window.PJLSort) and also require()-able, so
// scripts/test-crm-sorting.mjs can exercise the comparators directly.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PJLSort = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // en-CA + sensitivity "base" so case and accents don't split a name
  // ("MacDonald" next to "Macdonald"), and numeric so street numbers order
  // 2, 9, 10 rather than 10, 2, 9.
  const COLLATOR = new Intl.Collator("en-CA", { sensitivity: "base", numeric: true });

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  // Blank values always sort last, whichever direction the field is going.
  // A record with no name or no town is a gap in the data, and burying it
  // at the bottom of Z-A instead of floating it to the top is what someone
  // scanning the list actually wants.
  function compareText(a, b) {
    const left = text(a);
    const right = text(b);
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    return COLLATOR.compare(left, right);
  }

  // Newest first. Values are ISO strings; anything unparseable sorts last.
  function compareRecent(a, b) {
    const left = text(a);
    const right = text(b);
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    return right.localeCompare(left);
  }

  // Sort a copy — the caller's array is the unfiltered source of truth for
  // counts and select-all, and reordering it in place would make "3 of 40"
  // depend on which sort ran last.
  //
  // `spec` is { key | keys, direction, tiebreak }:
  //   keys      fields to compare in order (first non-equal wins)
  //   direction "asc" (default) or "desc"
  //   tiebreak  field compared last, always ascending, so equal primaries
  //             (every customer in one town) still land alphabetically
  //             instead of in file order.
  function sortRecords(records, spec) {
    const list = Array.isArray(records) ? records.slice() : [];
    if (!spec) return list;
    const keys = spec.keys || (spec.key ? [spec.key] : []);
    const compare = spec.compare || compareText;
    const sign = spec.direction === "desc" ? -1 : 1;
    return list.sort((a, b) => {
      for (const key of keys) {
        const left = a && a[key];
        const right = b && b[key];
        // Blank-vs-value is settled BEFORE the direction is applied, so
        // "no town" stays at the bottom in Z-A instead of being flipped to
        // the top. Reversing the order of the towns shouldn't promote the
        // records that have no town at all.
        const leftBlank = !text(left);
        const rightBlank = !text(right);
        if (leftBlank && rightBlank) continue; // tied on this key — try the next
        if (leftBlank) return 1;
        if (rightBlank) return -1;
        const result = compare(left, right);
        if (result !== 0) return result * sign;
      }
      // The tiebreak is always ascending: in a Z-A town sort you still want
      // each town's rows alphabetical, not reversed twice.
      if (spec.tiebreak) {
        return compareText(a && a[spec.tiebreak], b && b[spec.tiebreak]);
      }
      return 0;
    });
  }

  // Remember the chosen sort per page. localStorage can throw outright in a
  // locked-down browser, so every access is guarded and a failure just means
  // the page opens on its default.
  function readStored(storageKey, allowed, fallback) {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored && allowed.includes(stored)) return stored;
    } catch { /* private mode / blocked storage — use the default */ }
    return fallback;
  }

  function writeStored(storageKey, value) {
    try {
      window.localStorage.setItem(storageKey, value);
    } catch { /* nothing to do — the choice just won't survive the reload */ }
  }

  return { COLLATOR, compareText, compareRecent, sortRecords, readStored, writeStored };
});
