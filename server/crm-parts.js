// Shared parts catalog renderer. Used by:
//   - The follow-up modal (crm-followup.js) — pre-check inherited SKUs,
//     collect checked SKUs on submit.
//   - The tech-mode work-order page — standalone "Parts to bring back"
//     section that's always visible during the visit, persists ticks
//     to wo.materialsPacked, and pre-feeds the follow-up modal.
//
// Hierarchy: Category > Subcategory > Items (with size + description).
// Categories + subcategories collapse into <details>; items render as
// labeled checkboxes with size badge + description. Each input is a
// real <input type="checkbox" data-sku="..." class="crm-parts-input">
// so callers can read state with a plain querySelectorAll.

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

  // Render the parts tree into `container`. Replaces existing children.
  // `catalog` shape: { categories: [{key,label}], parts: { sku: {...} } }.
  // `opts.preChecked` — Set or array of SKUs to render as checked.
  // `opts.idPrefix` — prefix for input ids (avoids collision when the
  //   same renderer drops on a page twice — modal + tech standalone).
  // `opts.onChange(checkedSkus[])` — fires on every tick.
  function render(container, catalog, opts = {}) {
    if (!container || !catalog || !catalog.parts) return;
    const preChecked = opts.preChecked instanceof Set
      ? opts.preChecked
      : new Set(Array.isArray(opts.preChecked) ? opts.preChecked : []);
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
      // Open the category if any of its items are pre-checked, so
      // inherited SKUs are visible without clicking.
      const hasPreChecked = Array.from(subs.values()).flat().some((p) => preChecked.has(p.sku));
      if (hasPreChecked) catEl.open = true;
      const totalCount = Array.from(subs.values()).reduce((n, items) => n + items.length, 0);
      const checkedCount = Array.from(subs.values()).flat().filter((p) => preChecked.has(p.sku)).length;
      const summary = document.createElement("summary");
      summary.className = "crm-parts-cat-summary";
      summary.innerHTML = `
        <span class="crm-parts-cat-label">${escapeHtml(catDef.label)}</span>
        <span class="crm-parts-cat-meta">${totalCount}${checkedCount ? ` · <strong>${checkedCount} ticked</strong>` : ""}</span>
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
          const subPreChecked = items.some((p) => preChecked.has(p.sku));
          if (subPreChecked) subEl.open = true;
          const subSummary = document.createElement("summary");
          subSummary.className = "crm-parts-sub-summary";
          const subChecked = items.filter((p) => preChecked.has(p.sku)).length;
          subSummary.innerHTML = `
            <span class="crm-parts-sub-label">${escapeHtml(subName)}</span>
            <span class="crm-parts-sub-meta">${items.length}${subChecked ? ` · <strong>${subChecked}</strong>` : ""}</span>
          `;
          subEl.appendChild(subSummary);

          const list = document.createElement("div");
          list.className = "crm-parts-list";
          items.forEach((p) => {
            const id = idPrefix + p.sku.replace(/[^a-zA-Z0-9]/g, "_");
            const label = document.createElement("label");
            label.className = "crm-parts-row";
            label.htmlFor = id;
            const checked = preChecked.has(p.sku) ? "checked" : "";
            const sizeBadge = p.size ? `<span class="crm-parts-size">${escapeHtml(p.size)}</span>` : "";
            label.innerHTML = `
              <input type="checkbox" id="${id}" class="crm-parts-input" data-sku="${escapeHtml(p.sku)}" ${checked}>
              ${sizeBadge}
              <span class="crm-parts-desc">${escapeHtml(p.description || p.sku)}</span>
              <span class="crm-parts-pn">${escapeHtml(p.partNumber || "")}</span>
            `;
            list.appendChild(label);
          });
          subEl.appendChild(list);
          subWrap.appendChild(subEl);
        });
      catEl.appendChild(subWrap);
      container.appendChild(catEl);
    });

    // Wire change events. Re-renders the count chips as ticks change so
    // users see "3 ticked" badges update live without a full re-render.
    if (onChange) {
      container.addEventListener("change", (e) => {
        if (!e.target || !e.target.classList.contains("crm-parts-input")) return;
        const skus = Array.from(container.querySelectorAll(".crm-parts-input:checked")).map((cb) => cb.dataset.sku);
        onChange(skus);
      });
    }
  }

  // Read currently checked SKUs from a rendered container.
  function getCheckedSkus(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(".crm-parts-input:checked")).map((cb) => cb.dataset.sku);
  }

  // Set checkbox state (without firing change events) so callers can
  // sync state from outside (e.g. when the modal opens after a tech
  // already ticked some items in the inline section).
  function setCheckedSkus(container, skus) {
    if (!container) return;
    const set = new Set(Array.isArray(skus) ? skus : []);
    container.querySelectorAll(".crm-parts-input").forEach((cb) => {
      cb.checked = set.has(cb.dataset.sku);
    });
  }

  window.CrmParts = { render, getCheckedSkus, setCheckedSkus };
})();
