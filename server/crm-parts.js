// Shared parts catalog renderer. Used by:
//   - The follow-up modal (crm-followup.js) — pre-fill inherited SKU
//     quantities, collect picked qty map on submit.
//   - The tech-mode work-order page — standalone "Parts to bring back"
//     section that's always visible during the visit, persists qty map
//     to wo.materialsPacked, and pre-feeds the follow-up modal.
//
// Hierarchy: Category > Subcategory > Items (with size + description).
// Categories + subcategories collapse into <details>; items render with a
// quantity stepper on the LEFT (− / qty / +) followed by size badge,
// description, and part #. Quantity starts at 0 — anything with qty>0
// counts as "selected" and shows up in the cat/sub summary chips.
//
// State shape exposed to callers: `{ sku: qty (number) }`. Legacy
// boolean values (`true`) are coerced to qty=1 on render so old WOs
// migrate without backfill. The renderer stores qty values in a
// data-qty attribute on the row's <input type="number"> so callers can
// query state via querySelectorAll without a separate JS map.

(function () {
  if (window.CrmParts) return;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Coerce a caller-provided pre-fill into a `{ sku: qty }` map. Accepts
  // any of: Set<sku>, Array<sku>, { sku: bool }, { sku: number }.
  function normalizeQtyMap(input) {
    const map = {};
    if (!input) return map;
    if (input instanceof Set) {
      input.forEach((sku) => { if (sku) map[sku] = 1; });
      return map;
    }
    if (Array.isArray(input)) {
      input.forEach((sku) => { if (sku) map[sku] = 1; });
      return map;
    }
    if (typeof input === "object") {
      for (const [sku, val] of Object.entries(input)) {
        if (!sku) continue;
        if (val === true) { map[sku] = 1; continue; }
        if (val === false || val == null) continue;
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) map[sku] = n;
      }
    }
    return map;
  }

  // Render the parts tree into `container`. Replaces existing children.
  // `catalog` shape: { categories: [{key,label}], parts: { sku: {...} } }.
  // `opts.preQty` — qty map (or Set/Array of SKUs treated as qty=1, or
  //   legacy bool map {sku:true}) to pre-fill the steppers with.
  // `opts.preChecked` — legacy alias of preQty (kept so the follow-up
  //   modal can keep passing parentLineSkus without changes).
  // `opts.idPrefix` — prefix for input ids (avoids collision when the
  //   same renderer drops on a page twice — modal + tech standalone).
  // `opts.onChange(qtyMap)` — fires on every qty change. qtyMap is a
  //   plain object `{ sku: qty }` containing only SKUs with qty > 0.
  function render(container, catalog, opts = {}) {
    if (!container || !catalog || !catalog.parts) return;
    const preQty = normalizeQtyMap(opts.preQty || opts.preChecked);
    const idPrefix = opts.idPrefix || "crmpart_";
    const onChange = typeof opts.onChange === "function" ? opts.onChange : null;

    // Group: category → subcategory → items.
    const tree = new Map();
    for (const part of Object.values(catalog.parts)) {
      if (!part || !part.sku) continue;
      const cat = part.category || "other";
      const sub = part.subcategory || "Other";
      if (!tree.has(cat)) tree.set(cat, new Map());
      const subs = tree.get(cat);
      if (!subs.has(sub)) subs.set(sub, []);
      subs.get(sub).push(part);
    }

    // Sort items within each subcategory by size (numeric prefix), then
    // description, so 0.5" < 0.75" < 1" < 1.5" reads naturally.
    function sizeRank(s) {
      const m = String(s || "").match(/[\d.]+/);
      return m ? parseFloat(m[0]) : 999;
    }
    for (const subs of tree.values()) {
      for (const items of subs.values()) {
        items.sort((a, b) => sizeRank(a.size) - sizeRank(b.size) || (a.description || "").localeCompare(b.description || ""));
      }
    }

    container.innerHTML = "";

    // Walk categories in the order defined by catalog.categories.
    const cats = Array.isArray(catalog.categories) ? catalog.categories : [];
    cats.forEach((catDef) => {
      if (!tree.has(catDef.key)) return;
      const subs = tree.get(catDef.key);
      const catEl = document.createElement("details");
      catEl.className = "crm-parts-cat";
      // Open the category if any of its items have qty>0, so picked
      // SKUs are visible without clicking through.
      const hasPicked = Array.from(subs.values()).flat().some((p) => (preQty[p.sku] || 0) > 0);
      if (hasPicked) catEl.open = true;
      const totalCount = Array.from(subs.values()).reduce((n, items) => n + items.length, 0);
      const pickedCount = Array.from(subs.values()).flat().filter((p) => (preQty[p.sku] || 0) > 0).length;
      const summary = document.createElement("summary");
      summary.className = "crm-parts-cat-summary";
      summary.innerHTML = `
        <span class="crm-parts-cat-label">${escapeHtml(catDef.label)}</span>
        <span class="crm-parts-cat-meta">${totalCount}${pickedCount ? ` · <strong>${pickedCount} picked</strong>` : ""}</span>
      `;
      catEl.appendChild(summary);

      // Each subcategory under the category — also collapsible.
      const subWrap = document.createElement("div");
      subWrap.className = "crm-parts-subwrap";
      Array.from(subs.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .forEach(([subName, items]) => {
          const subEl = document.createElement("details");
          subEl.className = "crm-parts-sub";
          const subHasPicked = items.some((p) => (preQty[p.sku] || 0) > 0);
          if (subHasPicked) subEl.open = true;
          const subSummary = document.createElement("summary");
          subSummary.className = "crm-parts-sub-summary";
          const subPickedCount = items.filter((p) => (preQty[p.sku] || 0) > 0).length;
          subSummary.innerHTML = `
            <span class="crm-parts-sub-label">${escapeHtml(subName)}</span>
            <span class="crm-parts-sub-meta">${items.length}${subPickedCount ? ` · <strong>${subPickedCount}</strong>` : ""}</span>
          `;
          subEl.appendChild(subSummary);

          const list = document.createElement("div");
          list.className = "crm-parts-list";
          items.forEach((p) => {
            const id = idPrefix + p.sku.replace(/[^a-zA-Z0-9]/g, "_");
            const qty = preQty[p.sku] || 0;
            const row = document.createElement("div");
            row.className = "crm-parts-row" + (qty > 0 ? " is-picked" : "");
            const sizeBadge = p.size ? `<span class="crm-parts-size">${escapeHtml(p.size)}</span>` : `<span class="crm-parts-size crm-parts-size--blank"></span>`;
            row.innerHTML = `
              <span class="crm-parts-stepper" data-stepper>
                <button type="button" class="crm-parts-stepper-btn" data-step="-1" aria-label="Decrease quantity">−</button>
                <input type="number" id="${id}" class="crm-parts-input crm-parts-qty" data-sku="${escapeHtml(p.sku)}" value="${qty}" min="0" step="1" inputmode="numeric" aria-label="Quantity for ${escapeHtml(p.description || p.sku)}">
                <button type="button" class="crm-parts-stepper-btn" data-step="1" aria-label="Increase quantity">+</button>
              </span>
              ${sizeBadge}
              <label class="crm-parts-desc" for="${id}">${escapeHtml(p.description || p.sku)}</label>
              <span class="crm-parts-pn">${escapeHtml(p.partNumber || "")}</span>
            `;
            list.appendChild(row);
          });
          subEl.appendChild(list);
          subWrap.appendChild(subEl);
        });
      catEl.appendChild(subWrap);
      container.appendChild(catEl);
    });

    // Wire stepper buttons + direct number-input changes. A single
    // delegated listener handles both. We always normalize the value
    // (clamp to >= 0, integer) before firing onChange so callers don't
    // need to defend against junk input.
    function fireChange() {
      if (!onChange) return;
      const map = {};
      container.querySelectorAll(".crm-parts-qty").forEach((input) => {
        const n = Math.max(0, Math.floor(Number(input.value) || 0));
        if (n > 0) map[input.dataset.sku] = n;
      });
      onChange(map);
    }

    container.addEventListener("click", (e) => {
      const btn = e.target.closest(".crm-parts-stepper-btn");
      if (!btn || !container.contains(btn)) return;
      const stepper = btn.closest("[data-stepper]");
      const input = stepper && stepper.querySelector(".crm-parts-qty");
      if (!input) return;
      const cur = Math.max(0, Math.floor(Number(input.value) || 0));
      const step = Number(btn.dataset.step) || 0;
      const next = Math.max(0, cur + step);
      if (next === cur) return;
      input.value = String(next);
      input.closest(".crm-parts-row")?.classList.toggle("is-picked", next > 0);
      fireChange();
    });

    container.addEventListener("input", (e) => {
      const input = e.target;
      if (!input || !input.classList || !input.classList.contains("crm-parts-qty")) return;
      const n = Math.max(0, Math.floor(Number(input.value) || 0));
      // Don't bash the user's typing mid-edit; only sanitize on blur.
      input.closest(".crm-parts-row")?.classList.toggle("is-picked", n > 0);
      fireChange();
    });

    container.addEventListener("blur", (e) => {
      const input = e.target;
      if (!input || !input.classList || !input.classList.contains("crm-parts-qty")) return;
      const n = Math.max(0, Math.floor(Number(input.value) || 0));
      input.value = String(n);
    }, true);
  }

  // Read currently picked SKUs (qty > 0) from a rendered container.
  // Legacy helper — most new code should call getQuantities() instead.
  function getCheckedSkus(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(".crm-parts-qty"))
      .filter((input) => (Number(input.value) || 0) > 0)
      .map((input) => input.dataset.sku);
  }

  // Read the full qty map from a rendered container. Returns
  // `{ sku: qty }` containing only SKUs with qty > 0.
  function getQuantities(container) {
    const map = {};
    if (!container) return map;
    container.querySelectorAll(".crm-parts-qty").forEach((input) => {
      const n = Math.max(0, Math.floor(Number(input.value) || 0));
      if (n > 0) map[input.dataset.sku] = n;
    });
    return map;
  }

  // Set qty values from outside (without firing change events) so callers
  // can sync state — e.g. the follow-up modal opens after the tech
  // already adjusted ticks in the inline section. Accepts the same
  // shapes as opts.preQty in render().
  function setCheckedSkus(container, source) {
    if (!container) return;
    const map = normalizeQtyMap(source);
    container.querySelectorAll(".crm-parts-qty").forEach((input) => {
      const next = map[input.dataset.sku] || 0;
      input.value = String(next);
      input.closest(".crm-parts-row")?.classList.toggle("is-picked", next > 0);
    });
  }
  // Alias — clearer name for new callers.
  const setQuantities = setCheckedSkus;

  // Shared catalog loader. First caller fires the fetch; subsequent
  // callers (within the same page session) await the same promise.
  // Avoids the modal AND the tech-mode bringback each hitting /api/parts
  // independently. Browser cache (max-age=300) + SW cache handle longer
  // horizons; this handles the same-session case.
  let catalogPromise = null;
  function loadCatalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = fetch("/api/parts")
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.ok) throw new Error("catalog load failed");
        return {
          categories: data.categories || [],
          parts: data.parts || {},
          service_materials: data.service_materials || {}
        };
      })
      .catch((err) => {
        // Reset on failure so the next caller can retry instead of
        // forever resolving to nothing.
        catalogPromise = null;
        throw err;
      });
    return catalogPromise;
  }

  window.CrmParts = {
    render,
    getCheckedSkus,
    setCheckedSkus,
    getQuantities,
    setQuantities,
    normalizeQtyMap,
    loadCatalog
  };
})();
