/* =============================================================
   PJL PRICING INJECTOR
   Fetches /api/pricing (the single source of truth at /pricing.json)
   and replaces tokens on the page.

   Markup conventions:

     <span data-price="service_call">95</span>
        → replaces innerText with the formatted price ("$95")

     <span data-price="manifold_3valve" data-price-format="raw">135</span>
        → replaces with the bare number, no $ or comma ("135")

     <span data-price="head_replacement" data-price-format="amount">68</span>
        → replaces with "$68" (default behavior — same as no format)

     <span data-price="manifold_3valve" data-price-suffix=" flat">135</span>
        → renders "$135 flat"

     <script type="application/ld+json" data-pricing-schema>...</script>
        → JSON-LD blocks tagged this way will be regenerated server-side
          on a future pass; for now this script doesn't touch them.

   The HTML hardcoded value is the FALLBACK shown if /api/pricing fails
   (e.g. customer is on a stale cached page or offline). It's NOT a
   second source of truth — it's intended to be regenerated periodically
   from pricing.json by a build script.

   Endpoint: tries same-origin first (post-cutover), falls back to the
   onrender.com URL (pre-cutover, when this script runs on GitHub Pages).
   ============================================================= */
(function () {
  "use strict";
  const PRIMARY = "/api/pricing";
  const FALLBACK = "https://pjl-land-services-onrender-com.onrender.com/api/pricing";

  function formatMoney(value, opts) {
    const num = Number(value);
    if (!isFinite(num)) return String(value);
    if (opts && opts.format === "raw") return String(num);
    // $1,195 / $74.95 / $90 — strip trailing .00 for whole dollars
    const cents = Math.round(num * 100) % 100;
    if (cents === 0) return "$" + num.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return "$" + num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // Evaluate a simple formula like "service_call+2*head_replacement+manifold_3valve"
  // against the loaded pricing dictionary. Only +, -, *, /, parens, numbers, and
  // pricing keys are allowed — anything else is rejected.
  function evalFormula(expr, items) {
    if (!/^[\w\s+\-*/().]+$/.test(expr)) return null;
    const replaced = expr.replace(/[a-zA-Z_][\w]*/g, (key) => {
      const item = items[key];
      if (!item) throw new Error("unknown key: " + key);
      return String(item.price);
    });
    // Final sanity check — only digits/operators left
    if (!/^[\d\s+\-*/().]+$/.test(replaced)) return null;
    try {
      // eslint-disable-next-line no-new-func
      return Number(new Function("return (" + replaced + ");")());
    } catch (e) { return null; }
  }

  function applyPricing(pricing) {
    if (!pricing || !pricing.items) return;

    // 1. Simple key lookups: data-price="service_call"
    document.querySelectorAll("[data-price]").forEach((el) => {
      const key = el.getAttribute("data-price");
      const item = pricing.items[key];
      if (!item) { console.warn("[pricing-injector] unknown key:", key); return; }
      const format = el.getAttribute("data-price-format") || "amount";
      const suffix = el.getAttribute("data-price-suffix") || "";
      el.textContent = formatMoney(item.price, { format }) + suffix;
    });

    // 2. Computed formulas: data-pjl-quote-formula="service_call+2*head_replacement"
    document.querySelectorAll("[data-pjl-quote-formula]").forEach((el) => {
      const expr = el.getAttribute("data-pjl-quote-formula");
      try {
        const total = evalFormula(expr, pricing.items);
        if (total != null) el.textContent = formatMoney(total);
      } catch (e) {
        console.warn("[pricing-injector] formula failed:", expr, e?.message);
      }
    });

    // Expose the full pricing object on window for any inline-script use.
    window.__pjlPricing = pricing;
    document.dispatchEvent(new CustomEvent("pjl:pricing-loaded", { detail: pricing }));
  }

  async function fetchPricing(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function init() {
    try {
      const pricing = await fetchPricing(PRIMARY);
      applyPricing(pricing);
    } catch (e1) {
      try {
        const pricing = await fetchPricing(FALLBACK);
        applyPricing(pricing);
      } catch (e2) {
        // Both endpoints failed — page keeps its hardcoded fallback values.
        console.warn("[pricing-injector] could not fetch pricing, using HTML fallback:", e2?.message);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
