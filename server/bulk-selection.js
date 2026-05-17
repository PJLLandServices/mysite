// PJL CRM bulk selection controller.
//
// Each admin list page calls pjlBulkSelection.init({...}) once after its
// rows are first rendered. The controller:
//   - injects a checkbox column into the row container (CSS controls layout)
//   - tracks the selected id set
//   - renders the floating action toolbar when count > 0
//   - handles shift-click range, ctrl/cmd-A, escape clear
//   - calls back to the page when an action fires
//
// The controller is RESOURCE-AGNOSTIC. Per-resource action sets,
// confirmation copy, and follow-up server calls live in each page's JS.
//
// API:
//   const handle = pjlBulkSelection.init({
//     resource: "leads",               // for default copy / endpoint
//     listSelector: "#leadList",       // container holding the rows
//     rowSelector: ".pjl-lead-card",   // each selectable row
//     idAttribute: "data-lead-id",     // attribute to read the id from
//     actions: [
//       { id: "delete", label: "Delete", destructive: true, requireTypedConfirm: (n) => n > 5,
//         confirmTitle: (n) => `Delete ${n} ${n === 1 ? "lead" : "leads"}?`,
//         confirmBody: "These leads will be moved to Trash and permanently deleted after 30 days.",
//         run: async (ids) => fetchBulk("/api/admin/bulk/leads", { action: "delete", ids })
//       },
//       ...
//     ],
//     onUndoableSuccess: (action, ids, restoreFn) => {},
//     onActionComplete: () => {}        // page refreshes its list here
//   });
//
//   handle.refresh()    — re-scan rows after the page re-renders
//   handle.clear()      — clear selection and hide toolbar
//   handle.destroy()    — remove toolbar + listeners (page unmount)

(function () {
  const handles = new Map();
  let instanceCounter = 0;

  function init(config) {
    const instanceId = "bulksel_" + (++instanceCounter);
    const state = {
      instanceId,
      config: { ...config },
      selected: new Set(),
      lastClickedId: null,
      toolbarEl: null,
      listEl: null,
      rowAttribute: config.idAttribute || "data-id",
      destroyed: false,
      announceEl: null
    };

    state.listEl = document.querySelector(config.listSelector);
    if (!state.listEl) {
      console.warn("[pjlBulkSelection] list element not found:", config.listSelector);
      return null;
    }

    ensureAnnounceRegion(state);
    attachListListeners(state);
    decorateRows(state);

    document.addEventListener("keydown", state._keyHandler = (e) => handleGlobalKey(e, state));

    handles.set(instanceId, state);

    return {
      refresh: () => decorateRows(state),
      clear: () => clearSelection(state),
      getSelection: () => Array.from(state.selected),
      destroy: () => destroy(state)
    };
  }

  function ensureAnnounceRegion(state) {
    if (state.announceEl) return;
    let el = document.querySelector(".pjl-bulk-announce");
    if (!el) {
      el = document.createElement("div");
      el.className = "pjl-bulk-announce";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    state.announceEl = el;
  }

  function announce(state, text) {
    if (!state.announceEl) return;
    state.announceEl.textContent = text;
  }

  function attachListListeners(state) {
    state._clickHandler = (e) => {
      const cb = e.target.closest(".pjl-bulk-checkbox");
      if (!cb) return;
      const row = cb.closest(state.config.rowSelector);
      if (!row) return;
      const id = row.getAttribute(state.rowAttribute);
      if (!id) return;

      if (e.shiftKey && state.lastClickedId) {
        applyRangeSelection(state, state.lastClickedId, id);
      } else {
        toggleSelection(state, id, cb.checked);
      }
      state.lastClickedId = id;
      renderToolbar(state);
      updateRowVisuals(state);
      updateHeaderCheckbox(state);
    };
    state.listEl.addEventListener("click", state._clickHandler, true);
    // Also listen on change (keyboard space activates checkbox via change, not click)
    state._changeHandler = (e) => {
      if (!e.target.matches(".pjl-bulk-checkbox")) return;
      // The click handler above already covers mouse clicks; for keyboard
      // toggles, the change event fires without a click. Sync state.
      const row = e.target.closest(state.config.rowSelector);
      if (!row) return;
      const id = row.getAttribute(state.rowAttribute);
      if (!id) return;
      const isChecked = e.target.checked;
      if (isChecked) state.selected.add(id);
      else state.selected.delete(id);
      renderToolbar(state);
      updateRowVisuals(state);
      updateHeaderCheckbox(state);
    };
    state.listEl.addEventListener("change", state._changeHandler);
  }

  function applyRangeSelection(state, fromId, toId) {
    const rows = Array.from(state.listEl.querySelectorAll(state.config.rowSelector));
    const ids = rows.map((r) => r.getAttribute(state.rowAttribute));
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    for (let i = lo; i <= hi; i++) {
      const id = ids[i];
      if (id) state.selected.add(id);
    }
    syncCheckboxesToState(state);
  }

  function toggleSelection(state, id, checked) {
    if (checked) state.selected.add(id);
    else state.selected.delete(id);
  }

  function decorateRows(state) {
    if (state.destroyed) return;
    const rows = Array.from(state.listEl.querySelectorAll(state.config.rowSelector));
    const isTableRow = rows[0] && rows[0].tagName === "TR";
    rows.forEach((row) => {
      const id = row.getAttribute(state.rowAttribute);
      if (!id) return;
      if (!row.querySelector(".pjl-bulk-checkbox-wrap")) {
        const noun = (state.config.resource || "row").replace(/-/g, " ");
        const wrap = document.createElement("label");
        wrap.className = "pjl-bulk-checkbox-wrap";
        wrap.setAttribute("aria-label", "Select " + noun);
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "pjl-bulk-checkbox";
        cb.setAttribute("aria-label", "Select " + noun);
        wrap.appendChild(cb);
        // Stop the wrap click from bubbling to the row's primary handler
        // (e.g. opening the lead detail panel) so the checkbox is its own
        // click target.
        wrap.addEventListener("click", (e) => e.stopPropagation());

        if (isTableRow) {
          // Tables need a <td> to host the checkbox label — labels can't
          // be direct children of <tr>.
          const cell = document.createElement("td");
          cell.className = "pjl-bulk-checkbox-cell";
          cell.appendChild(wrap);
          row.insertBefore(cell, row.firstChild);
          // Also insert a matching <th> at the front of the thead row so
          // column widths and header labels stay aligned with the data.
          // Without this, every <th> ends up over the previous column and
          // an empty 8th column appears on the right (visible bug on
          // /admin/quote-folder and /admin/invoices).
          const table = state.listEl.closest("table") ||
            (state.listEl.parentElement && state.listEl.parentElement.closest && state.listEl.parentElement.closest("table"));
          const headerRow = table && table.querySelector("thead tr");
          if (headerRow && !headerRow.querySelector(".pjl-bulk-checkbox-th")) {
            const th = document.createElement("th");
            th.className = "pjl-bulk-checkbox-th";
            th.setAttribute("aria-hidden", "true");
            headerRow.insertBefore(th, headerRow.firstChild);
          }
        } else {
          row.insertBefore(wrap, row.firstChild);
        }
      }
      // Reflect current selection state on (re-)render.
      const cb = row.querySelector(".pjl-bulk-checkbox");
      if (cb) cb.checked = state.selected.has(id);
      row.classList.toggle("pjl-bulk-row-selected", state.selected.has(id));
    });
    // Prune ids that no longer have a row (e.g. after delete + re-render).
    const liveIds = new Set(rows.map((r) => r.getAttribute(state.rowAttribute)).filter(Boolean));
    for (const id of Array.from(state.selected)) {
      if (!liveIds.has(id)) state.selected.delete(id);
    }
    renderToolbar(state);
    updateHeaderCheckbox(state);
  }

  function updateRowVisuals(state) {
    const rows = Array.from(state.listEl.querySelectorAll(state.config.rowSelector));
    rows.forEach((row) => {
      const id = row.getAttribute(state.rowAttribute);
      if (!id) return;
      row.classList.toggle("pjl-bulk-row-selected", state.selected.has(id));
    });
  }

  function syncCheckboxesToState(state) {
    const rows = Array.from(state.listEl.querySelectorAll(state.config.rowSelector));
    rows.forEach((row) => {
      const id = row.getAttribute(state.rowAttribute);
      if (!id) return;
      const cb = row.querySelector(".pjl-bulk-checkbox");
      if (cb) cb.checked = state.selected.has(id);
    });
    updateRowVisuals(state);
  }

  function updateHeaderCheckbox(state) {
    // Each consuming page can opt-in to a select-all checkbox by putting an
    // element with class .pjl-bulk-select-all in its header. We sync its
    // state here: checked when ALL visible rows are selected, indeterminate
    // when SOME are, unchecked when none.
    const header = document.querySelector(".pjl-bulk-select-all");
    if (!header) return;
    const rows = Array.from(state.listEl.querySelectorAll(state.config.rowSelector));
    const ids = rows.map((r) => r.getAttribute(state.rowAttribute)).filter(Boolean);
    if (ids.length === 0) {
      header.checked = false;
      header.indeterminate = false;
      return;
    }
    const selectedVisible = ids.filter((id) => state.selected.has(id));
    if (selectedVisible.length === 0) {
      header.checked = false;
      header.indeterminate = false;
    } else if (selectedVisible.length === ids.length) {
      header.checked = true;
      header.indeterminate = false;
    } else {
      header.checked = false;
      header.indeterminate = true;
    }
    if (!header._bulkBound) {
      header._bulkBound = true;
      header.addEventListener("change", () => {
        const visible = Array.from(state.listEl.querySelectorAll(state.config.rowSelector))
          .map((r) => r.getAttribute(state.rowAttribute))
          .filter(Boolean);
        if (header.checked) {
          visible.forEach((id) => state.selected.add(id));
        } else {
          visible.forEach((id) => state.selected.delete(id));
        }
        syncCheckboxesToState(state);
        renderToolbar(state);
        updateHeaderCheckbox(state);
      });
    }
  }

  function renderToolbar(state) {
    const count = state.selected.size;
    if (count === 0) {
      removeToolbar(state);
      announce(state, "Selection cleared.");
      return;
    }
    if (!state.toolbarEl) {
      buildToolbar(state);
      announce(state, count + " " + nounFor(state.config.resource, count) + " selected. Action toolbar opened.");
    } else {
      updateToolbarCount(state);
    }
  }

  function buildToolbar(state) {
    const bar = document.createElement("div");
    bar.className = "pjl-bulk-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Bulk actions");

    const count = document.createElement("span");
    count.className = "pjl-bulk-toolbar-count";
    bar.appendChild(count);

    const actions = document.createElement("div");
    actions.className = "pjl-bulk-toolbar-actions";
    state.config.actions.forEach((action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pjl-bulk-toolbar-btn" + (action.destructive ? " pjl-bulk-toolbar-btn-destructive" : "");
      btn.textContent = action.label;
      btn.addEventListener("click", () => runAction(state, action, btn));
      actions.appendChild(btn);
    });
    bar.appendChild(actions);

    const trailing = document.createElement("div");
    trailing.className = "pjl-bulk-toolbar-trailing";

    const clearLink = document.createElement("button");
    clearLink.type = "button";
    clearLink.className = "pjl-bulk-toolbar-clear";
    clearLink.textContent = "Clear";
    clearLink.addEventListener("click", () => clearSelection(state));
    trailing.appendChild(clearLink);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pjl-bulk-toolbar-close";
    closeBtn.setAttribute("aria-label", "Dismiss selection toolbar");
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", () => clearSelection(state));
    trailing.appendChild(closeBtn);

    bar.appendChild(trailing);

    document.body.appendChild(bar);
    state.toolbarEl = bar;
    // Force a frame so the slide-in transition triggers.
    requestAnimationFrame(() => bar.classList.add("pjl-bulk-toolbar-open"));
    updateToolbarCount(state);
  }

  function updateToolbarCount(state) {
    if (!state.toolbarEl) return;
    const count = state.selected.size;
    const noun = nounFor(state.config.resource, count);
    const text = count + " " + noun + " selected";
    const slot = state.toolbarEl.querySelector(".pjl-bulk-toolbar-count");
    if (slot) slot.textContent = text;
  }

  function removeToolbar(state) {
    if (!state.toolbarEl) return;
    const bar = state.toolbarEl;
    state.toolbarEl = null;
    bar.classList.remove("pjl-bulk-toolbar-open");
    bar.classList.add("pjl-bulk-toolbar-closing");
    setTimeout(() => {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }, 200);
  }

  function nounFor(resource, count) {
    const singular = {
      leads: "lead",
      properties: "property",
      "work-orders": "work order",
      quotes: "quote",
      invoices: "invoice",
      "material-lists": "material list",
      suppliers: "supplier",
      "purchase-orders": "purchase order"
    }[resource] || "item";
    if (count === 1) return singular;
    if (resource === "properties") return "properties";
    return singular + "s";
  }

  async function runAction(state, action, btn) {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    const count = ids.length;

    if (action.confirmTitle || action.confirmBody) {
      const requireTyped = typeof action.requireTypedConfirm === "function"
        ? action.requireTypedConfirm(count)
        : !!action.requireTypedConfirm;
      const title = typeof action.confirmTitle === "function" ? action.confirmTitle(count) : action.confirmTitle || "Confirm action";
      const body = typeof action.confirmBody === "function" ? action.confirmBody(count) : action.confirmBody || "";
      const ok = await window.pjlBulkModal.confirm({
        title,
        body,
        confirmLabel: action.confirmLabel || action.label,
        destructive: !!action.destructive,
        requireTypedConfirm: requireTyped
      });
      if (!ok) return;
    }

    // Disable the toolbar while in flight; the page may also disable
    // its row checkboxes via .pjl-bulk-toolbar-busy on body if needed.
    const buttons = state.toolbarEl ? Array.from(state.toolbarEl.querySelectorAll("button")) : [];
    buttons.forEach((b) => b.disabled = true);
    document.body.classList.add("pjl-bulk-toolbar-busy");

    try {
      const result = await action.run(ids);
      const failedCount = result && Array.isArray(result.failedIds) ? result.failedIds.length : 0;
      const succeededIds = result && Array.isArray(result.succeededIds) ? result.succeededIds : ids;
      const message = (result && result.message) || defaultSuccessMessage(action, count, failedCount);

      // Keep failed ids selected so the user can retry; drop succeeded.
      for (const sid of succeededIds) state.selected.delete(sid);

      if (failedCount > 0) {
        window.pjlBulkToast.show({
          type: "error",
          message: message
        });
      } else {
        const undoFn = action.undo
          ? () => action.undo(succeededIds).then(() => {
              if (typeof state.config.onActionComplete === "function") state.config.onActionComplete();
            })
          : null;
        window.pjlBulkToast.show({
          type: "success",
          message,
          undo: undoFn
        });
      }

      if (typeof state.config.onActionComplete === "function") {
        state.config.onActionComplete();
      }
    } catch (err) {
      const msg = (err && err.message) || "Couldn't complete that action.";
      window.pjlBulkToast.show({ type: "error", message: msg });
    } finally {
      buttons.forEach((b) => b.disabled = false);
      document.body.classList.remove("pjl-bulk-toolbar-busy");
      // Re-render toolbar with whatever's still selected (failed ids).
      renderToolbar(state);
    }
  }

  function defaultSuccessMessage(action, count, failed) {
    const noun = action.noun || "item" + (count === 1 ? "" : "s");
    if (failed > 0) return (count - failed) + " of " + count + " " + noun + " " + (action.verb || "updated") + ". " + failed + " failed.";
    return count + " " + noun + " " + (action.verb || "updated") + ".";
  }

  function clearSelection(state) {
    state.selected.clear();
    syncCheckboxesToState(state);
    renderToolbar(state);
    updateHeaderCheckbox(state);
  }

  function handleGlobalKey(e, state) {
    if (e.key === "Escape" && state.selected.size > 0) {
      // Don't steal Esc from modals — only fire if no modal is open.
      if (document.querySelector(".pjl-bulk-modal-backdrop")) return;
      clearSelection(state);
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      // Only intercept when focus is inside the list (or its checkboxes).
      const active = document.activeElement;
      if (active && (state.listEl.contains(active) || active.classList.contains("pjl-bulk-checkbox"))) {
        e.preventDefault();
        const rows = Array.from(state.listEl.querySelectorAll(state.config.rowSelector));
        rows.forEach((row) => {
          const id = row.getAttribute(state.rowAttribute);
          if (id) state.selected.add(id);
        });
        syncCheckboxesToState(state);
        renderToolbar(state);
        updateHeaderCheckbox(state);
      }
    }
  }

  function destroy(state) {
    state.destroyed = true;
    if (state._clickHandler) state.listEl.removeEventListener("click", state._clickHandler, true);
    if (state._changeHandler) state.listEl.removeEventListener("change", state._changeHandler);
    if (state._keyHandler) document.removeEventListener("keydown", state._keyHandler);
    removeToolbar(state);
    state.selected.clear();
    handles.delete(state.instanceId);
  }

  // Helper for pages to call the unified bulk endpoint. Returns the parsed
  // JSON envelope from the server (succeededIds, failedIds, message).
  async function callBulk(resource, action, ids, payload) {
    const res = await fetch("/api/admin/bulk/" + encodeURIComponent(resource), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action, ids, payload: payload || null })
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && (data.error || (data.errors && data.errors[0]))) || ("Server error " + res.status));
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  window.pjlBulkSelection = { init, callBulk };
})();
