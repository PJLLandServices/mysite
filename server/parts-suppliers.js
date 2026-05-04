// Catalog assignments — Phase 3.
// Bulk grid that maps every SKU in parts.json to a primary supplier.
// Edits batch into a pending Map and flush via PATCH /api/part-suppliers
// after a 1.2s debounce. The savebar shows live counts of assigned vs
// unassigned and a save-state indicator.

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
    saveState: document.getElementById("psSaveState")
  };

  const state = {
    catalog: null,             // { categories: [], parts: { sku: {...} } }
    suppliers: [],             // [{id,name,...}] (non-archived only)
    pending: new Map(),        // sku -> [supplierId, ...] (or [] to clear)
    saveTimer: null,
    saving: false,
    pendingError: null,
    lastSavedAt: null
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function fmtCents(c) { return "$" + ((Number(c) || 0) / 100).toFixed(2); }

  function relTime(iso) {
    if (!iso) return "";
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 5) return "just now";
    if (seconds < 60) return seconds + "s ago";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    return new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric" });
  }

  async function boot() {
    try {
      const [partsRes, supRes] = await Promise.all([
        fetch("/api/parts", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/suppliers", { cache: "no-store" }).then((r) => r.json())
      ]);
      if (!partsRes.ok || !supRes.ok) throw new Error("Couldn't load catalog or suppliers.");
      state.catalog = { categories: partsRes.categories || [], parts: partsRes.parts || {} };
      state.suppliers = supRes.suppliers || [];
      els.loading.hidden = true;
      els.tableWrap.hidden = false;
      els.savebar.hidden = false;
      hydrateCategoryFilter();
      render();
      setSaveState("saved", new Date().toISOString());
    } catch (err) {
      els.loading.hidden = true;
      els.error.hidden = false;
      els.error.textContent = err.message || "Couldn't load.";
    }
  }

  function hydrateCategoryFilter() {
    const cats = state.catalog.categories || [];
    for (const cat of cats) {
      const opt = document.createElement("option");
      opt.value = cat.key;
      opt.textContent = cat.label || cat.key;
      els.categoryFilter.appendChild(opt);
    }
  }

  function effectiveSupplierIds(part) {
    // The pending edit (if any) wins over the catalog's stored value.
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
    // Sort by category > subcategory > size for predictable scanning.
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
      els.body.innerHTML = `<tr><td colspan="5" style="padding:30px;text-align:center;color:#7A7A72">No parts match the current filters.</td></tr>`;
      return;
    }

    const supplierOptions = state.suppliers
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join("");

    els.body.innerHTML = visible.map((p) => {
      const ids = effectiveSupplierIds(p);
      const primary = ids[0] || "";
      const isMissing = !primary;
      const sizeBadge = p.size ? `<span class="ps-desc-size">${escapeHtml(p.size)}</span>` : "";
      return `
        <tr class="${isMissing ? "is-missing" : ""}">
          <td><span class="ps-sku">${escapeHtml(p.sku)}</span></td>
          <td>
            <div class="ps-desc">
              ${sizeBadge}
              <span class="ps-desc-text">${escapeHtml(p.description || p.sku)}</span>
            </div>
          </td>
          <td><span class="ps-cat"><strong>${escapeHtml(p.category || "—")}</strong>${p.subcategory ? "<br>" + escapeHtml(p.subcategory) : ""}</span></td>
          <td><span class="ps-price">${fmtCents(p.priceCents)}</span></td>
          <td class="ps-supplier-cell">
            <select class="ps-supplier-select ${isMissing ? "is-missing" : ""}" data-sku="${escapeHtml(p.sku)}">
              <option value="">— none —</option>
              ${supplierOptions}
            </select>
          </td>
        </tr>
      `;
    }).join("");

    // After innerHTML write, set each <select>'s value (can't put `selected`
    // attribute inline because the value comes from runtime state).
    els.body.querySelectorAll("select[data-sku]").forEach((sel) => {
      const sku = sel.dataset.sku;
      const part = state.catalog.parts[sku];
      if (!part) return;
      const ids = effectiveSupplierIds(part);
      sel.value = ids[0] || "";
    });
  }

  // ---- Save state ----------------------------------------------------
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
      // Persist into the in-memory catalog so subsequent renders reflect
      // what's now on disk.
      for (const [sku, ids] of state.pending.entries()) {
        if (state.catalog.parts[sku]) state.catalog.parts[sku].supplierIds = ids.slice();
      }
      state.pending.clear();
      setSaveState("saved", new Date().toISOString());
      // Re-render so the per-row "missing" indicator + savebar counts update.
      render();
    } catch (err) {
      state.pendingError = err.message || "Save failed";
      setSaveState("error");
    } finally {
      state.saving = false;
    }
  }

  // ---- Event wiring --------------------------------------------------
  els.body.addEventListener("change", (event) => {
    const sel = event.target.closest("select[data-sku]");
    if (!sel) return;
    const sku = sel.dataset.sku;
    const value = sel.value;
    state.pending.set(sku, value ? [value] : []);
    // Update the row's "is-missing" class immediately for visual feedback.
    const row = sel.closest("tr");
    if (row) row.classList.toggle("is-missing", !value);
    sel.classList.toggle("is-missing", !value);
    scheduleSave();
  });
  els.search.addEventListener("input", () => render());
  els.categoryFilter.addEventListener("change", () => render());
  els.assignmentFilter.addEventListener("change", () => render());

  window.addEventListener("beforeunload", () => {
    if (state.pending.size === 0) return;
    // Fire-and-forget keepalive so unsaved edits aren't lost on nav-away.
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

  boot();
})();
