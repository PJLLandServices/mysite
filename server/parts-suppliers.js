// Catalog page — manages both the per-SKU supplier assignments
// (Phase 3) AND the catalog itself (adds / edits / deletes / xlsx
// import + export, from this brief).
//
// Reads via GET /api/parts?admin=1 (returns the merged catalog plus an
// `overrides` block telling us which SKUs are runtime additions vs
// edited baseline vs tombstoned). Writes go through the catalog
// endpoints; supplier assignments still go through PATCH
// /api/part-suppliers (unchanged behaviour). The xlsx parse + build
// happens client-side via SheetJS (CDN-loaded in the HTML) — same
// pattern as properties-import.

(function () {
  const els = {
    search: document.getElementById("psSearch"),
    categoryFilter: document.getElementById("psCategoryFilter"),
    assignmentFilter: document.getElementById("psAssignmentFilter"),
    count: document.getElementById("psCount"),
    loading: document.getElementById("psLoading"),
    error: document.getElementById("psError"),
    tableWrap: document.getElementById("psTableWrap"),
    body: document.getElementById("psBody"),
    savebar: document.getElementById("psSavebar"),
    statAssigned: document.getElementById("psStatAssigned"),
    statMissing: document.getElementById("psStatMissing"),
    saveState: document.getElementById("psSaveState"),
    toast: document.getElementById("psToast"),
    // Toolbar
    addBtn: document.getElementById("addPartsBtn"),
    importBtn: document.getElementById("importBtn"),
    exportBtn: document.getElementById("exportBtn"),
    // Deleted section
    deletedToggle: document.getElementById("psDeletedToggle"),
    deletedToggleBtn: document.getElementById("psDeletedToggleBtn"),
    deletedCount: document.getElementById("psDeletedCount"),
    deletedWrap: document.getElementById("psDeletedWrap"),
    deletedBody: document.getElementById("psDeletedBody"),
    // Kebab menu
    kebabMenu: document.getElementById("psKebabMenu"),
    // Add parts modal
    addPartsModal: document.getElementById("addPartsModal"),
    addPartsRows: document.getElementById("addPartsRows"),
    addPartsError: document.getElementById("addPartsError"),
    addAnotherRowBtn: document.getElementById("addAnotherRowBtn"),
    addPartsCancel: document.getElementById("addPartsCancel"),
    addPartsSubmit: document.getElementById("addPartsSubmit"),
    // Edit modal
    editPartModal: document.getElementById("editPartModal"),
    editPartForm: document.getElementById("editPartForm"),
    editPartTitle: document.getElementById("editPartTitle"),
    editPartError: document.getElementById("editPartError"),
    editPartCancel: document.getElementById("editPartCancel"),
    editPartSubmit: document.getElementById("editPartSubmit"),
    editSku: document.getElementById("editSku"),
    editPartNumber: document.getElementById("editPartNumber"),
    editCategory: document.getElementById("editCategory"),
    editSubcategory: document.getElementById("editSubcategory"),
    editSize: document.getElementById("editSize"),
    editDescription: document.getElementById("editDescription"),
    editPrice: document.getElementById("editPrice"),
    editUnit: document.getElementById("editUnit"),
    // Delete confirm
    deletePartModal: document.getElementById("deletePartModal"),
    deletePartCopy: document.getElementById("deletePartCopy"),
    deletePartCancel: document.getElementById("deletePartCancel"),
    deletePartConfirm: document.getElementById("deletePartConfirm"),
    // Import wizard
    importModal: document.getElementById("importModal"),
    importStep1: document.getElementById("importStep1"),
    importStep2: document.getElementById("importStep2"),
    importFile: document.getElementById("importFile"),
    importHelp: document.getElementById("importHelp"),
    importSummary: document.getElementById("importSummary"),
    importDiffAdded: document.getElementById("importDiffAdded"),
    importDiffEdited: document.getElementById("importDiffEdited"),
    importDiffDeleted: document.getElementById("importDiffDeleted"),
    importDeleteEnabled: document.getElementById("importDeleteEnabled"),
    importStep1Error: document.getElementById("importStep1Error"),
    importStep2Error: document.getElementById("importStep2Error"),
    importCancel: document.getElementById("importCancel"),
    importApply: document.getElementById("importApply"),
    downloadTemplateBtn: document.getElementById("downloadTemplateBtn")
  };

  const state = {
    catalog: null,                  // { categories, parts:{sku:{...}} }
    suppliers: [],
    overrides: {                    // From /api/parts?admin=1
      addedSkus: new Set(),
      editedSkus: new Set(),
      deletedSkus: new Set(),
      edited: {},                   // per-sku patch (so we know "original" for tooltip)
      baseline: {},                 // per-sku baseline snapshot for revert
      deletedParts: {}              // baseline records for tombstoned SKUs
    },
    pending: new Map(),             // supplier-id pending edits (unchanged from Phase 3)
    saveTimer: null,
    saving: false,
    pendingError: null,
    lastSavedAt: null,
    // Catalog UI state
    deletedShown: false,
    activeKebabSku: null,
    pendingDeleteSku: null,
    pendingEditSku: null,
    // Import state
    importRows: null,
    importId: null,
    importDiff: null
  };

  // ===== Helpers ========================================================

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function fmtCents(c) { return "$" + ((Number(c) || 0) / 100).toFixed(2); }
  function centsToDollarString(c) { return ((Number(c) || 0) / 100).toFixed(2); }
  function dollarsToCents(d) {
    const n = Number(d);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }
  function todayStamp() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function relTime(iso) {
    if (!iso) return "";
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 5) return "just now";
    if (seconds < 60) return seconds + "s ago";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    return new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric" });
  }
  // Toast: temporary status banner anchored next to the toolbar. Includes
  // an optional Undo callback that's wired to a button rendered inside
  // the toast for 10 s.
  let toastTimer = null;
  function toast(message, opts = {}) {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    els.toast.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = message;
    els.toast.appendChild(text);
    if (opts.undo) {
      const undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.className = "ps-toast-undo";
      undoBtn.textContent = "Undo";
      undoBtn.addEventListener("click", () => {
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        els.toast.hidden = true;
        opts.undo();
      });
      els.toast.appendChild(undoBtn);
    }
    els.toast.classList.toggle("ps-toast--error", !!opts.error);
    els.toast.hidden = false;
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, opts.undo ? 10000 : 4000);
  }

  // ===== Boot ===========================================================

  async function boot() {
    try {
      await reloadCatalog({ skipRender: true });
      // Suppliers — fetched once (separate index, mutates only via the
      // Suppliers tab).
      const supRes = await fetch("/api/suppliers", { cache: "no-store" }).then((r) => r.json());
      if (!supRes.ok) throw new Error("Couldn't load suppliers.");
      state.suppliers = supRes.suppliers || [];
      els.loading.hidden = true;
      els.tableWrap.hidden = false;
      els.savebar.hidden = false;
      hydrateCategoryFilter();
      hydrateEditCategoryOptions();
      render();
      renderDeletedSection();
      setSaveState("saved", new Date().toISOString());
    } catch (err) {
      els.loading.hidden = true;
      els.error.hidden = false;
      els.error.textContent = err.message || "Couldn't load.";
    }
  }

  async function reloadCatalog({ skipRender = false } = {}) {
    const partsRes = await fetch("/api/parts?admin=1", { cache: "no-store" }).then((r) => r.json());
    if (!partsRes.ok) throw new Error("Couldn't load catalog.");
    state.catalog = { categories: partsRes.categories || [], parts: partsRes.parts || {} };
    const ov = partsRes.overrides || {};
    state.overrides.addedSkus = new Set(ov.addedSkus || []);
    state.overrides.editedSkus = new Set(ov.editedSkus || []);
    state.overrides.deletedSkus = new Set(ov.deletedSkus || []);
    state.overrides.edited = ov.edited || {};
    state.overrides.baseline = ov.baseline || {};
    state.overrides.deletedParts = ov.deletedParts || {};
    if (!skipRender) {
      render();
      renderDeletedSection();
    }
  }

  function hydrateCategoryFilter() {
    // Clear stale options (skip the "All categories" placeholder at index 0).
    while (els.categoryFilter.options.length > 1) els.categoryFilter.remove(1);
    const cats = state.catalog.categories || [];
    for (const cat of cats) {
      const opt = document.createElement("option");
      opt.value = cat.key;
      opt.textContent = cat.label || cat.key;
      els.categoryFilter.appendChild(opt);
    }
  }

  function hydrateEditCategoryOptions() {
    els.editCategory.innerHTML = "";
    for (const cat of state.catalog.categories || []) {
      const opt = document.createElement("option");
      opt.value = cat.key;
      opt.textContent = cat.label || cat.key;
      els.editCategory.appendChild(opt);
    }
  }

  // ===== Main table render ============================================

  function effectiveSupplierIds(part) {
    if (state.pending.has(part.sku)) return state.pending.get(part.sku);
    return Array.isArray(part.supplierIds) ? part.supplierIds : [];
  }

  function applyFilters(parts) {
    const q = els.search.value.trim().toLowerCase();
    const cat = els.categoryFilter.value;
    const assignment = els.assignmentFilter.value;
    return parts.filter((p) => {
      if (cat && p.category !== cat) return false;
      if (assignment === "missing" && effectiveSupplierIds(p).length > 0) return false;
      if (assignment === "assigned" && effectiveSupplierIds(p).length === 0) return false;
      if (q) {
        const hay = [p.sku, p.partNumber, p.description, p.subcategory, p.size]
          .map((v) => String(v || "").toLowerCase()).join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function render() {
    const allParts = Object.values(state.catalog.parts);
    function sizeRank(s) {
      const m = String(s || "").match(/[\d.]+/);
      return m ? parseFloat(m[0]) : 999;
    }
    allParts.sort((a, b) =>
      (a.category || "").localeCompare(b.category || "") ||
      (a.subcategory || "").localeCompare(b.subcategory || "") ||
      sizeRank(a.size) - sizeRank(b.size) ||
      (a.description || "").localeCompare(b.description || "")
    );
    const visible = applyFilters(allParts);

    let assigned = 0, missing = 0;
    for (const p of allParts) {
      if (effectiveSupplierIds(p).length) assigned++;
      else missing++;
    }
    els.statAssigned.textContent = `${assigned} assigned`;
    els.statMissing.textContent = `${missing} unassigned`;
    els.count.textContent = `${visible.length} of ${allParts.length} parts`;

    if (!visible.length) {
      els.body.innerHTML = `<tr><td colspan="6" class="ps-empty">No parts match the current filters.</td></tr>`;
      return;
    }

    const supplierOptions = state.suppliers
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join("");

    els.body.innerHTML = visible.map((p) => renderRow(p, supplierOptions)).join("");

    // After innerHTML write, set each <select>'s value (can't rely on
    // inline `selected` because the value comes from runtime state).
    els.body.querySelectorAll("select[data-sku]").forEach((sel) => {
      const sku = sel.dataset.sku;
      const part = state.catalog.parts[sku];
      if (!part) return;
      const ids = effectiveSupplierIds(part);
      sel.value = ids[0] || "";
    });
  }

  function renderRow(p, supplierOptions) {
    const ids = effectiveSupplierIds(p);
    const primary = ids[0] || "";
    const isMissing = !primary;
    const sizeBadge = p.size ? `<span class="ps-desc-size">${escapeHtml(p.size)}</span>` : "";
    const isAdded = state.overrides.addedSkus.has(p.sku);
    const isEdited = state.overrides.editedSkus.has(p.sku);
    const newPill = isAdded ? `<span class="ps-new-pill" title="Added from the catalog UI">NEW</span>` : "";
    // Price cell — click-to-edit. Indicator shows baseline price as
    // tooltip when the price has been changed from its baseline. The
    // dot is a button so it's keyboard-accessible (Enter → revert).
    let priceIndicator = "";
    if (isEdited && state.overrides.baseline[p.sku] != null) {
      const basePrice = state.overrides.baseline[p.sku].priceCents;
      if (basePrice != null && basePrice !== p.priceCents) {
        priceIndicator = `<button type="button" class="ps-price-revert" data-sku="${escapeHtml(p.sku)}" data-baseline-cents="${basePrice}" title="Price changed from ${fmtCents(basePrice)}. Click to revert." aria-label="Revert price to ${fmtCents(basePrice)}">&bull;</button>`;
      }
    }
    return `
      <tr data-sku="${escapeHtml(p.sku)}" class="${isMissing ? "is-missing" : ""}">
        <td><span class="ps-sku">${escapeHtml(p.sku)}</span>${newPill}</td>
        <td>
          <div class="ps-desc">
            ${sizeBadge}
            <span class="ps-desc-text">${escapeHtml(p.description || p.sku)}</span>
          </div>
        </td>
        <td><span class="ps-cat"><strong>${escapeHtml(p.category || "—")}</strong>${p.subcategory ? "<br>" + escapeHtml(p.subcategory) : ""}</span></td>
        <td class="ps-price-cell">
          ${priceIndicator}
          <button type="button" class="ps-price ps-price-edit" data-sku="${escapeHtml(p.sku)}" data-cents="${Number(p.priceCents) || 0}" aria-label="Edit price for ${escapeHtml(p.sku)}">${fmtCents(p.priceCents)}</button>
        </td>
        <td class="ps-supplier-cell">
          <select class="ps-supplier-select ${isMissing ? "is-missing" : ""}" data-sku="${escapeHtml(p.sku)}">
            <option value="">— none —</option>
            ${supplierOptions}
          </select>
        </td>
        <td class="ps-actions-col">
          <button type="button" class="ps-kebab" data-sku="${escapeHtml(p.sku)}" aria-label="Actions for ${escapeHtml(p.sku)}" aria-haspopup="menu" aria-expanded="false">&#x22EE;</button>
        </td>
      </tr>
    `;
  }

  function renderDeletedSection() {
    const deletedSkus = [...state.overrides.deletedSkus];
    if (deletedSkus.length === 0) {
      els.deletedToggle.hidden = true;
      els.deletedWrap.hidden = true;
      els.deletedToggleBtn.setAttribute("aria-expanded", "false");
      els.deletedToggleBtn.textContent = "";
      els.deletedCount.textContent = "";
      state.deletedShown = false;
      return;
    }
    els.deletedToggle.hidden = false;
    els.deletedCount.textContent = `(${deletedSkus.length})`;
    els.deletedToggleBtn.firstChild.textContent = state.deletedShown
      ? "Hide deleted "
      : "Show deleted ";
    els.deletedToggleBtn.setAttribute("aria-expanded", String(state.deletedShown));
    els.deletedWrap.hidden = !state.deletedShown;
    if (state.deletedShown) {
      els.deletedBody.innerHTML = deletedSkus.map((sku) => {
        const p = state.overrides.deletedParts[sku] || { sku, description: "(missing baseline record)", category: "", priceCents: 0 };
        return `
          <tr data-sku="${escapeHtml(sku)}">
            <td><span class="ps-sku">${escapeHtml(sku)}</span></td>
            <td>${escapeHtml(p.description || sku)}</td>
            <td><span class="ps-cat"><strong>${escapeHtml(p.category || "—")}</strong></span></td>
            <td><span class="ps-price">${fmtCents(p.priceCents)}</span></td>
            <td class="ps-actions-col">
              <button type="button" class="ps-action ps-action--ghost ps-restore-btn" data-sku="${escapeHtml(sku)}">Restore</button>
            </td>
          </tr>
        `;
      }).join("");
    }
  }

  // ===== Supplier save state (unchanged from Phase 3) ================
  function setSaveState(stateName, ts) {
    els.saveState.classList.remove("is-saving", "is-saved", "is-error");
    if (stateName === "saving") {
      els.saveState.classList.add("is-saving");
      els.saveState.textContent = "Saving…";
    } else if (stateName === "saved") {
      els.saveState.classList.add("is-saved");
      state.lastSavedAt = ts || new Date().toISOString();
      els.saveState.textContent = `Saved · ${relTime(state.lastSavedAt)}`;
    } else if (stateName === "error") {
      els.saveState.classList.add("is-error");
      els.saveState.textContent = state.pendingError || "Save failed";
    } else if (stateName === "dirty") {
      els.saveState.textContent = `Pending: ${state.pending.size} change${state.pending.size === 1 ? "" : "s"}`;
    }
  }
  setInterval(() => {
    if (els.saveState.classList.contains("is-saved") && state.lastSavedAt) {
      els.saveState.textContent = `Saved · ${relTime(state.lastSavedAt)}`;
    }
  }, 5000);

  function scheduleSave() {
    setSaveState("dirty");
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, 1200);
  }

  async function flushSave() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    if (state.saving || state.pending.size === 0) return;
    state.saving = true;
    state.pendingError = null;
    setSaveState("saving");
    const updates = {};
    for (const [sku, ids] of state.pending.entries()) updates[sku] = ids;
    try {
      const r = await fetch("/api/part-suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        state.pendingError = (data.errors && data.errors[0]) || `Save failed (${r.status})`;
        setSaveState("error");
        return;
      }
      for (const [sku, ids] of state.pending.entries()) {
        if (state.catalog.parts[sku]) state.catalog.parts[sku].supplierIds = ids.slice();
      }
      state.pending.clear();
      setSaveState("saved", new Date().toISOString());
      render();
    } catch (err) {
      state.pendingError = err.message || "Save failed";
      setSaveState("error");
    } finally {
      state.saving = false;
    }
  }

  // ===== Body delegation =============================================
  els.body.addEventListener("change", (event) => {
    const sel = event.target.closest("select[data-sku]");
    if (!sel) return;
    const sku = sel.dataset.sku;
    const value = sel.value;
    state.pending.set(sku, value ? [value] : []);
    const row = sel.closest("tr");
    if (row) row.classList.toggle("is-missing", !value);
    sel.classList.toggle("is-missing", !value);
    scheduleSave();
  });

  els.body.addEventListener("click", (event) => {
    const kebab = event.target.closest(".ps-kebab");
    if (kebab) {
      event.stopPropagation();
      openKebab(kebab);
      return;
    }
    const revert = event.target.closest(".ps-price-revert");
    if (revert) {
      const sku = revert.dataset.sku;
      const baselineCents = Number(revert.dataset.baselineCents);
      if (Number.isFinite(baselineCents)) {
        commitPriceEdit(sku, baselineCents);
      }
      return;
    }
    const priceBtn = event.target.closest(".ps-price-edit");
    if (priceBtn) {
      beginPriceEdit(priceBtn);
      return;
    }
  });

  els.search.addEventListener("input", () => render());
  els.categoryFilter.addEventListener("change", () => render());
  els.assignmentFilter.addEventListener("change", () => render());

  // ===== Inline price edit ==========================================
  function beginPriceEdit(btn) {
    const sku = btn.dataset.sku;
    const cents = Number(btn.dataset.cents) || 0;
    const cell = btn.parentElement;
    // Replace the button with an editable number input. Stash the
    // original cents on the cell so we can restore on Esc.
    cell.dataset.originalCents = String(cents);
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.01";
    input.min = "0";
    input.className = "ps-price-input";
    input.value = centsToDollarString(cents);
    input.dataset.sku = sku;
    cell.replaceChild(input, btn);
    // Hide any revert indicator while editing (clutters the cell).
    const revert = cell.querySelector(".ps-price-revert");
    if (revert) revert.hidden = true;
    input.focus();
    input.select();

    function finish(save) {
      if (save) {
        const next = dollarsToCents(input.value);
        if (next == null) {
          input.classList.add("ps-input-error");
          input.focus();
          return false;
        }
        if (next === cents) {
          restoreCell(sku, cents);
          return true;
        }
        commitPriceEdit(sku, next, input);
        return true;
      }
      restoreCell(sku, cents);
      return true;
    }

    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (finish(true)) moveToNextPriceCell(cell, +1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Tab") {
        // Native tab moves out of cell entirely. Override → move to
        // the next price cell in the table.
        event.preventDefault();
        const direction = event.shiftKey ? -1 : 1;
        if (finish(true)) moveToNextPriceCell(cell, direction);
      }
    });
  }

  function moveToNextPriceCell(currentCell, direction) {
    const allCells = [...els.body.querySelectorAll(".ps-price-cell")];
    const idx = allCells.indexOf(currentCell);
    if (idx === -1) return;
    const next = allCells[idx + direction];
    if (!next) return;
    const btn = next.querySelector(".ps-price-edit");
    if (btn) beginPriceEdit(btn);
  }

  function restoreCell(sku, cents) {
    const row = els.body.querySelector(`tr[data-sku="${cssEscape(sku)}"]`);
    if (!row) return;
    const cell = row.querySelector(".ps-price-cell");
    if (!cell) return;
    // Rebuild the cell from the current state — picks up the latest
    // priceCents AND the revert-indicator state (in case the user just
    // saved a change).
    rebuildPriceCell(cell, sku);
  }

  function rebuildPriceCell(cell, sku) {
    const part = state.catalog.parts[sku];
    if (!part) return;
    let revertHtml = "";
    if (state.overrides.editedSkus.has(sku) && state.overrides.baseline[sku] != null) {
      const basePrice = state.overrides.baseline[sku].priceCents;
      if (basePrice != null && basePrice !== part.priceCents) {
        revertHtml = `<button type="button" class="ps-price-revert" data-sku="${escapeHtml(sku)}" data-baseline-cents="${basePrice}" title="Price changed from ${fmtCents(basePrice)}. Click to revert." aria-label="Revert price to ${fmtCents(basePrice)}">&bull;</button>`;
      }
    }
    cell.innerHTML = `${revertHtml}<button type="button" class="ps-price ps-price-edit" data-sku="${escapeHtml(sku)}" data-cents="${Number(part.priceCents) || 0}" aria-label="Edit price for ${escapeHtml(sku)}">${fmtCents(part.priceCents)}</button>`;
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch);
  }

  async function commitPriceEdit(sku, newCents, inputEl) {
    try {
      // Optimistic UI — paint the new value immediately.
      const part = state.catalog.parts[sku];
      if (part) part.priceCents = newCents;
      // If this matches baseline, drop the edit from overrides. Otherwise
      // mark as edited.
      const baseline = state.overrides.baseline[sku] || null;
      const baseCents = baseline ? baseline.priceCents : null;
      if (state.overrides.addedSkus.has(sku)) {
        // Runtime addition — overrides stay unchanged conceptually;
        // the addition's record updates on the server.
      } else if (baseCents != null && baseCents === newCents) {
        state.overrides.editedSkus.delete(sku);
        if (state.overrides.edited[sku]) delete state.overrides.edited[sku].priceCents;
      } else {
        state.overrides.editedSkus.add(sku);
        state.overrides.edited[sku] = { ...(state.overrides.edited[sku] || {}), priceCents: newCents };
        // Make sure we have a baseline snapshot so the indicator can
        // render with a tooltip. The server's first response already
        // populated this; if missing we leave the indicator without a
        // tooltip rather than blocking.
      }
      const row = els.body.querySelector(`tr[data-sku="${cssEscape(sku)}"]`);
      if (row) {
        const cell = row.querySelector(".ps-price-cell");
        if (cell) rebuildPriceCell(cell, sku);
      }
      const r = await fetch(`/api/parts/${encodeURIComponent(sku)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceCents: newCents })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't save price.");
      // Re-sync from the canonical record (e.g. server normalized cents)
      if (data.part && state.catalog.parts[sku]) {
        Object.assign(state.catalog.parts[sku], data.part);
        const cell = els.body.querySelector(`tr[data-sku="${cssEscape(sku)}"] .ps-price-cell`);
        if (cell) rebuildPriceCell(cell, sku);
      }
      toast("Saved");
    } catch (err) {
      // Revert optimistic UI on failure.
      if (inputEl) inputEl.classList.add("ps-input-error");
      toast(err.message || "Couldn't save price.", { error: true });
      await reloadCatalog();
    }
  }

  // ===== Kebab menu ===================================================
  function openKebab(triggerBtn) {
    const sku = triggerBtn.dataset.sku;
    if (state.activeKebabSku === sku && !els.kebabMenu.hidden) {
      closeKebab();
      return;
    }
    state.activeKebabSku = sku;
    els.kebabMenu.hidden = false;
    triggerBtn.setAttribute("aria-expanded", "true");
    // Position next to the trigger (right-aligned, below).
    const rect = triggerBtn.getBoundingClientRect();
    const menuW = 160;
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    els.kebabMenu.style.top = `${rect.bottom + scrollY + 4}px`;
    els.kebabMenu.style.left = `${rect.right + scrollX - menuW}px`;
    els.kebabMenu.style.minWidth = `${menuW}px`;
  }
  function closeKebab() {
    if (!els.kebabMenu.hidden) {
      const triggerBtn = els.body.querySelector(`.ps-kebab[data-sku="${cssEscape(state.activeKebabSku || "")}"]`);
      if (triggerBtn) triggerBtn.setAttribute("aria-expanded", "false");
    }
    els.kebabMenu.hidden = true;
    state.activeKebabSku = null;
  }
  document.addEventListener("click", (event) => {
    if (els.kebabMenu.hidden) return;
    if (event.target.closest(".ps-kebab-menu") || event.target.closest(".ps-kebab")) return;
    closeKebab();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.kebabMenu.hidden) closeKebab();
  });
  els.kebabMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-kebab-action]");
    if (!item || !state.activeKebabSku) return;
    const action = item.dataset.kebabAction;
    const sku = state.activeKebabSku;
    closeKebab();
    if (action === "edit") openEditModal(sku);
    else if (action === "delete") openDeleteConfirm(sku);
  });

  // ===== Add parts modal =============================================
  els.addBtn.addEventListener("click", () => openAddPartsModal());
  els.addPartsCancel.addEventListener("click", () => closeAddPartsModal());
  els.addAnotherRowBtn.addEventListener("click", () => appendAddPartsRow());
  els.addPartsSubmit.addEventListener("click", () => submitAddParts());
  els.addPartsModal.addEventListener("click", (event) => {
    if (event.target === els.addPartsModal) closeAddPartsModal();
  });

  function openAddPartsModal() {
    els.addPartsRows.innerHTML = "";
    appendAddPartsRow();
    els.addPartsError.hidden = true;
    els.addPartsModal.hidden = false;
    refreshAddPartsSubmitLabel();
    setTimeout(() => {
      const firstInput = els.addPartsRows.querySelector("input,select");
      if (firstInput) firstInput.focus();
    }, 0);
  }
  function closeAddPartsModal() { els.addPartsModal.hidden = true; }

  function categoryOptionsHtml() {
    return (state.catalog.categories || [])
      .map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label || c.key)}</option>`)
      .join("");
  }
  function appendAddPartsRow() {
    const tr = document.createElement("tr");
    tr.className = "ps-add-row";
    tr.innerHTML = `
      <td><input type="text" name="sku" maxlength="64" required></td>
      <td><input type="text" name="partNumber" maxlength="64"></td>
      <td><select name="category" required><option value="">Choose…</option>${categoryOptionsHtml()}</select></td>
      <td><input type="text" name="subcategory" maxlength="120" required></td>
      <td><input type="text" name="size" maxlength="40"></td>
      <td><input type="text" name="description" maxlength="240" required></td>
      <td><input type="number" name="price" step="0.01" min="0" required></td>
      <td><input type="text" name="unit" list="ps-unit-options" maxlength="30" placeholder="each"></td>
      <td><button type="button" class="ps-row-remove" aria-label="Remove row">&times;</button></td>
    `;
    els.addPartsRows.appendChild(tr);
    refreshAddPartsSubmitLabel();
  }
  els.addPartsRows.addEventListener("click", (event) => {
    const rem = event.target.closest(".ps-row-remove");
    if (!rem) return;
    if (els.addPartsRows.children.length === 1) {
      // Keep at least one row; just clear it.
      rem.closest("tr").querySelectorAll("input,select").forEach((el) => { el.value = ""; });
    } else {
      rem.closest("tr").remove();
    }
    refreshAddPartsSubmitLabel();
  });
  els.addPartsRows.addEventListener("input", () => refreshAddPartsSubmitLabel());

  function refreshAddPartsSubmitLabel() {
    // Count rows that have *any* content. Helps avoid "Save 4 parts"
    // when 3 of them are empty placeholders.
    const rows = [...els.addPartsRows.querySelectorAll(".ps-add-row")];
    const populated = rows.filter((tr) => {
      return [...tr.querySelectorAll("input,select")].some((el) => String(el.value || "").trim());
    });
    const n = populated.length || rows.length;
    els.addPartsSubmit.textContent = `Save ${n} part${n === 1 ? "" : "s"}`;
  }

  function collectAddPartsRows() {
    const rows = [...els.addPartsRows.querySelectorAll(".ps-add-row")];
    const out = [];
    for (const tr of rows) {
      const f = (name) => tr.querySelector(`[name="${name}"]`).value;
      const allEmpty = ["sku", "partNumber", "category", "subcategory", "size", "description", "price", "unit"]
        .every((k) => !String(f(k) || "").trim());
      if (allEmpty) continue;
      out.push({
        sku: String(f("sku") || "").trim(),
        partNumber: String(f("partNumber") || "").trim() || undefined,
        category: String(f("category") || "").trim(),
        subcategory: String(f("subcategory") || "").trim(),
        size: String(f("size") || "").trim(),
        description: String(f("description") || "").trim(),
        price: f("price"),
        unit: String(f("unit") || "").trim() || "each"
      });
    }
    return out;
  }

  async function submitAddParts() {
    els.addPartsError.hidden = true;
    const records = collectAddPartsRows();
    if (records.length === 0) {
      els.addPartsError.textContent = "Add at least one part.";
      els.addPartsError.hidden = false;
      return;
    }
    // Client-side dupe check (within batch). Server re-checks but a
    // quick local check gives faster feedback.
    const skus = new Set();
    for (const r of records) {
      if (!r.sku) {
        els.addPartsError.textContent = "Each row needs a SKU.";
        els.addPartsError.hidden = false;
        return;
      }
      if (skus.has(r.sku)) {
        els.addPartsError.textContent = `SKU "${r.sku}" is repeated.`;
        els.addPartsError.hidden = false;
        return;
      }
      skus.add(r.sku);
    }
    els.addPartsSubmit.disabled = true;
    try {
      const r = await fetch("/api/parts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(records.length === 1 ? records[0] : { parts: records })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't save.");
      const count = (data.created && data.created.length) || (data.part ? 1 : 0);
      closeAddPartsModal();
      await reloadCatalog();
      toast(`Added ${count} part${count === 1 ? "" : "s"} to catalog`);
    } catch (err) {
      els.addPartsError.textContent = err.message || "Save failed.";
      els.addPartsError.hidden = false;
    } finally {
      els.addPartsSubmit.disabled = false;
    }
  }

  // ===== Edit details modal =========================================
  function openEditModal(sku) {
    const part = state.catalog.parts[sku];
    if (!part) return;
    state.pendingEditSku = sku;
    els.editPartTitle.textContent = `Edit ${sku}`;
    els.editSku.value = sku;
    els.editPartNumber.value = part.partNumber || "";
    els.editCategory.value = part.category || "";
    els.editSubcategory.value = part.subcategory || "";
    els.editSize.value = part.size || "";
    els.editDescription.value = part.description || "";
    els.editPrice.value = centsToDollarString(part.priceCents);
    els.editUnit.value = part.unit || "each";
    els.editPartError.hidden = true;
    els.editPartModal.hidden = false;
    setTimeout(() => els.editDescription.focus(), 0);
  }
  els.editPartCancel.addEventListener("click", () => closeEditModal());
  els.editPartSubmit.addEventListener("click", () => submitEdit());
  els.editPartModal.addEventListener("click", (event) => {
    if (event.target === els.editPartModal) closeEditModal();
  });
  function closeEditModal() { els.editPartModal.hidden = true; state.pendingEditSku = null; }

  async function submitEdit() {
    const sku = state.pendingEditSku;
    if (!sku) return;
    els.editPartError.hidden = true;
    const payload = {
      partNumber: els.editPartNumber.value.trim(),
      category: els.editCategory.value.trim(),
      subcategory: els.editSubcategory.value.trim(),
      size: els.editSize.value.trim(),
      description: els.editDescription.value.trim(),
      priceCents: dollarsToCents(els.editPrice.value),
      unit: els.editUnit.value.trim()
    };
    if (payload.priceCents == null) {
      els.editPartError.textContent = "Price must be a number, zero or higher.";
      els.editPartError.hidden = false;
      return;
    }
    els.editPartSubmit.disabled = true;
    try {
      const r = await fetch(`/api/parts/${encodeURIComponent(sku)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't save.");
      closeEditModal();
      await reloadCatalog();
      toast(`Updated ${sku}`);
    } catch (err) {
      els.editPartError.textContent = err.message || "Save failed.";
      els.editPartError.hidden = false;
    } finally {
      els.editPartSubmit.disabled = false;
    }
  }

  // ===== Delete + restore ============================================
  function openDeleteConfirm(sku) {
    state.pendingDeleteSku = sku;
    els.deletePartCopy.textContent = `Delete ${sku} from catalog? It will be hidden from material lists. You can restore it from "Show deleted" at the bottom of the table.`;
    els.deletePartModal.hidden = false;
    setTimeout(() => els.deletePartCancel.focus(), 0);
  }
  els.deletePartCancel.addEventListener("click", () => { els.deletePartModal.hidden = true; state.pendingDeleteSku = null; });
  els.deletePartConfirm.addEventListener("click", () => submitDelete());
  els.deletePartModal.addEventListener("click", (event) => {
    if (event.target === els.deletePartModal) { els.deletePartModal.hidden = true; state.pendingDeleteSku = null; }
  });

  async function submitDelete() {
    const sku = state.pendingDeleteSku;
    if (!sku) return;
    els.deletePartConfirm.disabled = true;
    const wasRuntimeAdd = state.overrides.addedSkus.has(sku);
    try {
      const r = await fetch(`/api/parts/${encodeURIComponent(sku)}`, { method: "DELETE" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't delete.");
      els.deletePartModal.hidden = true;
      await reloadCatalog();
      // Runtime-added SKUs are removed outright (no tombstone) — Undo
      // can't bring them back via the restore endpoint. For baseline
      // SKUs the Undo link calls restore.
      if (wasRuntimeAdd) {
        toast(`Deleted ${sku}`);
      } else {
        toast(`Deleted ${sku}`, {
          undo: async () => {
            try {
              await fetch(`/api/parts/${encodeURIComponent(sku)}/restore`, { method: "POST" });
              await reloadCatalog();
              toast(`Restored ${sku}`);
            } catch (err) {
              toast(err.message || "Couldn't restore.", { error: true });
            }
          }
        });
      }
    } catch (err) {
      toast(err.message || "Couldn't delete.", { error: true });
    } finally {
      state.pendingDeleteSku = null;
      els.deletePartConfirm.disabled = false;
    }
  }

  els.deletedToggleBtn.addEventListener("click", () => {
    state.deletedShown = !state.deletedShown;
    renderDeletedSection();
  });
  els.deletedBody.addEventListener("click", async (event) => {
    const btn = event.target.closest(".ps-restore-btn");
    if (!btn) return;
    const sku = btn.dataset.sku;
    btn.disabled = true;
    try {
      const r = await fetch(`/api/parts/${encodeURIComponent(sku)}/restore`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't restore.");
      await reloadCatalog();
      toast(`Restored ${sku}`);
    } catch (err) {
      btn.disabled = false;
      toast(err.message || "Couldn't restore.", { error: true });
    }
  });

  // ===== Export xlsx =================================================
  els.exportBtn.addEventListener("click", () => downloadExport());
  function downloadExport() {
    if (typeof XLSX === "undefined") {
      toast("Export library not loaded yet — refresh and try again.", { error: true });
      return;
    }
    const allParts = Object.values(state.catalog.parts);
    // Sort same as the visible table so the file mirrors what's on
    // screen.
    function sizeRank(s) {
      const m = String(s || "").match(/[\d.]+/);
      return m ? parseFloat(m[0]) : 999;
    }
    allParts.sort((a, b) =>
      (a.category || "").localeCompare(b.category || "") ||
      (a.subcategory || "").localeCompare(b.subcategory || "") ||
      sizeRank(a.size) - sizeRank(b.size) ||
      (a.description || "").localeCompare(b.description || "")
    );
    const supplierById = new Map(state.suppliers.map((s) => [s.id, s.name]));
    const aoa = [["sku", "partNumber", "category", "subcategory", "size", "description", "price", "unit", "primarySupplier"]];
    for (const p of allParts) {
      const supplierName = (Array.isArray(p.supplierIds) && p.supplierIds[0])
        ? (supplierById.get(p.supplierIds[0]) || "")
        : "";
      // price column is the dollar amount as a real number (not text)
      // so Excel users can sort / formula on it cleanly.
      const priceDollars = Number(((Number(p.priceCents) || 0) / 100).toFixed(2));
      aoa.push([
        p.sku,
        p.partNumber || p.sku,
        p.category || "",
        p.subcategory || "",
        p.size || "",
        p.description || "",
        priceDollars,
        p.unit || "each",
        supplierName
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Mark the price column as 2-decimal number-typed for clean
    // viewing in Excel.
    const lastRow = aoa.length;
    for (let r = 2; r <= lastRow; r++) {
      const ref = XLSX.utils.encode_cell({ r: r - 1, c: 6 });
      if (ws[ref]) { ws[ref].t = "n"; ws[ref].z = "0.00"; }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Catalog");
    XLSX.writeFile(wb, `pjl-catalog-${todayStamp()}.xlsx`);
  }

  els.downloadTemplateBtn.addEventListener("click", () => {
    if (typeof XLSX === "undefined") {
      toast("Template library not loaded yet — refresh and try again.", { error: true });
      return;
    }
    const aoa = [["sku", "partNumber", "category", "subcategory", "size", "description", "price", "unit"]];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Catalog");
    XLSX.writeFile(wb, "pjl-catalog-template.xlsx");
  });

  // ===== Import xlsx wizard ==========================================
  els.importBtn.addEventListener("click", () => openImportModal());
  els.importCancel.addEventListener("click", () => closeImportModal());
  els.importModal.addEventListener("click", (event) => {
    if (event.target === els.importModal) closeImportModal();
  });
  els.importFile.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) parseImportFile(file);
  });
  // Dropzone drag-drop
  const dropzone = els.importStep1.querySelector(".ps-dropzone");
  if (dropzone) {
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("is-drag");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-drag"));
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-drag");
      const file = event.dataTransfer.files?.[0];
      if (file) parseImportFile(file);
    });
  }
  els.importDeleteEnabled.addEventListener("change", () => recomputeImportDiffWithDeletions());
  els.importApply.addEventListener("click", () => commitImport());

  function openImportModal() {
    els.importModal.hidden = false;
    els.importStep1.hidden = false;
    els.importStep2.hidden = true;
    els.importApply.hidden = true;
    els.importApply.disabled = false;
    els.importStep1Error.hidden = true;
    els.importStep2Error.hidden = true;
    els.importFile.value = "";
    els.importDeleteEnabled.checked = false;
    state.importRows = null;
    state.importId = null;
    state.importDiff = null;
  }
  function closeImportModal() { els.importModal.hidden = true; }

  function parseImportFile(file) {
    if (typeof XLSX === "undefined") {
      els.importStep1Error.textContent = "xlsx library not loaded. Refresh the page and try again.";
      els.importStep1Error.hidden = false;
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const firstSheet = wb.Sheets[wb.SheetNames[0]];
        if (!firstSheet) throw new Error("No sheets in this file.");
        const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
        if (rows.length === 0) throw new Error("The file has no rows.");
        // Normalize header keys: lowercase first letter / strip
        // whitespace / handle camelCase + snake variants.
        const norm = rows.map(normalizeImportRow).filter((r) => r.sku);
        if (norm.length === 0) {
          throw new Error("Couldn't find a \"sku\" column. Check that it's a valid xlsx with a header row.");
        }
        state.importRows = norm;
        previewImportDiff();
      } catch (err) {
        els.importStep1Error.textContent = err.message || "Couldn't read that file. Check that it's a valid xlsx with a \"sku\" column.";
        els.importStep1Error.hidden = false;
      }
    };
    reader.onerror = () => {
      els.importStep1Error.textContent = "Couldn't read the file.";
      els.importStep1Error.hidden = false;
    };
    reader.readAsArrayBuffer(file);
  }

  function normalizeImportRow(raw) {
    const out = {};
    for (const key of Object.keys(raw || {})) {
      const cleanKey = String(key).trim();
      // Try several canonical-key variants.
      const lower = cleanKey.toLowerCase().replace(/[^a-z0-9]+/g, "");
      let target = null;
      if (lower === "sku") target = "sku";
      else if (lower === "partnumber" || lower === "partno" || lower === "part") target = "partNumber";
      else if (lower === "category" || lower === "cat") target = "category";
      else if (lower === "subcategory" || lower === "subcat") target = "subcategory";
      else if (lower === "size") target = "size";
      else if (lower === "description" || lower === "desc") target = "description";
      else if (lower === "price" || lower === "pricedollars") target = "price";
      else if (lower === "pricecents") target = "priceCents";
      else if (lower === "unit") target = "unit";
      else if (lower === "primarysupplier" || lower === "supplier") target = null; // Ignored on import — supplier mapping is its own page.
      if (target) {
        let val = raw[key];
        if (typeof val === "string") val = val.trim();
        out[target] = val;
      }
    }
    return out;
  }

  async function previewImportDiff() {
    els.importStep1Error.hidden = true;
    els.importApply.disabled = false;
    try {
      const r = await fetch("/api/parts/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: state.importRows, includeDeletions: els.importDeleteEnabled.checked })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't preview import.");
      state.importId = data.importId;
      state.importDiff = data.diff;
      renderImportDiff();
      els.importStep1.hidden = true;
      els.importStep2.hidden = false;
      els.importApply.hidden = false;
    } catch (err) {
      els.importStep1Error.textContent = err.message || "Couldn't preview import.";
      els.importStep1Error.hidden = false;
    }
  }

  async function recomputeImportDiffWithDeletions() {
    if (!state.importRows) return;
    // Re-fetch the preview with the new flag — server is the authority on
    // what's "missing" since it knows the current merged catalog.
    await previewImportDiff();
  }

  function renderImportDiff() {
    const diff = state.importDiff || { added: {}, edited: {}, deleted: [], unchanged: 0 };
    const addedCount = Object.keys(diff.added).length;
    const editedCount = Object.keys(diff.edited).length;
    const deletedCount = (diff.deleted || []).length;
    const total = addedCount + editedCount + deletedCount;
    els.importSummary.textContent = total
      ? `${total} change${total === 1 ? "" : "s"} found: ${addedCount} added · ${editedCount} edited · ${deletedCount} missing from file · ${diff.unchanged || 0} unchanged.`
      : `No changes — file matches the current catalog.`;
    els.importApply.disabled = total === 0;
    els.importApply.textContent = total === 0 ? "No changes to apply" : `Apply ${total} change${total === 1 ? "" : "s"}`;

    // Added
    const addedRows = Object.entries(diff.added).map(([sku, rec]) => `
      <tr>
        <td><input type="checkbox" class="ps-diff-check" data-section="added" data-sku="${escapeHtml(sku)}" checked></td>
        <td><span class="ps-sku">${escapeHtml(sku)}</span></td>
        <td>${escapeHtml(rec.description || "")}</td>
        <td>${escapeHtml(rec.priceCents != null ? fmtCents(rec.priceCents) : (rec.price != null ? "$" + Number(rec.price).toFixed(2) : "—"))}</td>
      </tr>
    `).join("");
    els.importDiffAdded.querySelector('tbody[data-tbody="added"]').innerHTML = addedRows || `<tr><td colspan="4" class="ps-empty">No additions.</td></tr>`;
    els.importDiffAdded.querySelector('.ps-diff-count').textContent = `(${addedCount})`;

    // Edited
    const editedRows = Object.entries(diff.edited).map(([sku, patch]) => {
      const current = state.catalog.parts[sku] || {};
      const changes = Object.entries(patch).filter(([k]) => k !== "editedAt").map(([k, v]) => {
        const before = current[k];
        return `<span class="ps-diff-field"><strong>${escapeHtml(k)}</strong>: ${escapeHtml(formatFieldValue(k, before))} → ${escapeHtml(formatFieldValue(k, v))}</span>`;
      }).join("<br>");
      return `
        <tr>
          <td><input type="checkbox" class="ps-diff-check" data-section="edited" data-sku="${escapeHtml(sku)}" checked></td>
          <td><span class="ps-sku">${escapeHtml(sku)}</span></td>
          <td>${changes}</td>
        </tr>
      `;
    }).join("");
    els.importDiffEdited.querySelector('tbody[data-tbody="edited"]').innerHTML = editedRows || `<tr><td colspan="3" class="ps-empty">No edits.</td></tr>`;
    els.importDiffEdited.querySelector('.ps-diff-count').textContent = `(${editedCount})`;

    // Deleted
    const deleteEnabled = els.importDeleteEnabled.checked;
    const deletedRows = (diff.deleted || []).map((sku) => {
      const p = state.catalog.parts[sku] || {};
      return `
        <tr>
          <td><input type="checkbox" class="ps-diff-check" data-section="deleted" data-sku="${escapeHtml(sku)}" ${deleteEnabled ? "checked" : ""} ${deleteEnabled ? "" : "disabled"}></td>
          <td><span class="ps-sku">${escapeHtml(sku)}</span></td>
          <td>${escapeHtml(p.description || "")}</td>
        </tr>
      `;
    }).join("");
    els.importDiffDeleted.querySelector('tbody[data-tbody="deleted"]').innerHTML = deletedRows || `<tr><td colspan="3" class="ps-empty">Nothing missing from this file.</td></tr>`;
    els.importDiffDeleted.querySelector('.ps-diff-count').textContent = `(${deletedCount})`;
  }

  function formatFieldValue(key, v) {
    if (v == null) return "—";
    if (key === "priceCents") return fmtCents(v);
    return String(v);
  }

  async function commitImport() {
    if (!state.importId) return;
    const selections = { added: [], edited: [], deleted: [] };
    els.importModal.querySelectorAll(".ps-diff-check").forEach((cb) => {
      if (!cb.checked) return;
      const section = cb.dataset.section;
      if (selections[section]) selections[section].push(cb.dataset.sku);
    });
    els.importApply.disabled = true;
    try {
      const r = await fetch("/api/parts/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId: state.importId, selections })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't apply import.");
      const c = data.counts || { added: 0, edited: 0, deleted: 0 };
      closeImportModal();
      await reloadCatalog();
      toast(`Applied changes — ${c.added} added, ${c.edited} edited, ${c.deleted} deleted`);
    } catch (err) {
      els.importStep2Error.textContent = err.message || "Couldn't apply import.";
      els.importStep2Error.hidden = false;
      els.importApply.disabled = false;
    }
  }

  // ===== Beforeunload (unsaved supplier edits) =======================
  window.addEventListener("beforeunload", () => {
    if (state.pending.size === 0) return;
    const updates = {};
    for (const [sku, ids] of state.pending.entries()) updates[sku] = ids;
    try {
      fetch("/api/part-suppliers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
        keepalive: true
      });
    } catch {}
  });

  // Esc closes the topmost open modal.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.addPartsModal.hidden) { closeAddPartsModal(); return; }
    if (!els.editPartModal.hidden) { closeEditModal(); return; }
    if (!els.deletePartModal.hidden) { els.deletePartModal.hidden = true; state.pendingDeleteSku = null; return; }
    if (!els.importModal.hidden) { closeImportModal(); return; }
  });

  boot();
})();
