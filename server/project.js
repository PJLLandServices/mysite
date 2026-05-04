// Project detail — Phase 2.
// Header (editable fields + status), attached Work Orders section,
// attached Material Lists section, archive/delete footer. Auto-save on
// field edits (1.2s debounce). The status select in the sticky savebar
// drives lifecycle transitions independent of the scroll position.

(function () {
  const els = {
    loading: document.getElementById("projLoading"),
    error: document.getElementById("projError"),
    page: document.getElementById("projPage"),
    id: document.getElementById("projId"),
    status: document.getElementById("projStatus"),
    source: document.getElementById("projSource"),
    name: document.getElementById("projName"),
    customerName: document.getElementById("projCustomerName"),
    customerEmail: document.getElementById("projCustomerEmail"),
    customerPhone: document.getElementById("projCustomerPhone"),
    propertyId: document.getElementById("projPropertyId"),
    address: document.getElementById("projAddress"),
    description: document.getElementById("projDescription"),
    notes: document.getElementById("projNotes"),

    wosEmpty: document.getElementById("projWosEmpty"),
    wosList: document.getElementById("projWosList"),
    attachWoButton: document.getElementById("attachWoButton"),
    attachWoModal: document.getElementById("attachWoModal"),
    attachWoSearch: document.getElementById("attachWoSearch"),
    attachWoResults: document.getElementById("attachWoResults"),
    attachWoCancel: document.getElementById("attachWoCancel"),

    mlsEmpty: document.getElementById("projMlsEmpty"),
    mlsList: document.getElementById("projMlsList"),
    newMaterialListButton: document.getElementById("newMaterialListButton"),

    archiveButton: document.getElementById("archiveButton"),
    deleteButton: document.getElementById("deleteButton"),

    savebar: document.getElementById("projSavebar"),
    statusSelect: document.getElementById("projStatusSelect"),
    saveState: document.getElementById("projSaveState")
  };

  const STATUS_LABELS = {
    planning: "Planning",
    active: "Active",
    complete: "Complete",
    archived: "Archived"
  };
  const ML_STATUS_LABELS = {
    draft: "Draft",
    in_progress: "In progress",
    complete: "Complete",
    archived: "Archived"
  };
  const WO_STATUS_LABELS = {
    scheduled: "Scheduled",
    dispatched: "Dispatched",
    en_route: "En route",
    on_site: "On site",
    in_progress: "In progress",
    awaiting_approval: "Awaiting approval",
    completed: "Completed",
    cancelled: "Cancelled",
    no_show: "No show"
  };

  const state = {
    projectId: null,
    project: null,
    materialLists: [],
    workOrders: new Map(),    // woId -> WO record (cached)
    saveTimer: null,
    saving: false,
    lastSavedAt: null,
    pendingError: null,
    woSearchCache: null
  };

  // ---- Utilities ----------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function fmtCents(c) { return "$" + ((Number(c) || 0) / 100).toFixed(2); }
  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  }
  function relTime(iso) {
    if (!iso) return "";
    const diffMs = Date.now() - new Date(iso).getTime();
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 5) return "just now";
    if (seconds < 60) return seconds + "s ago";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    return new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function getProjectIdFromUrl() {
    const m = location.pathname.match(/^\/admin\/project\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ---- Boot ---------------------------------------------------------
  async function boot() {
    state.projectId = getProjectIdFromUrl();
    if (!state.projectId) { showError("No project id in URL."); return; }
    await loadProject();
  }

  function showError(message) {
    els.loading.hidden = true;
    els.error.hidden = false;
    els.error.textContent = message;
  }

  async function loadProject() {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}`, { cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showError((data.errors && data.errors[0]) || `Couldn't load project (${r.status})`);
        return;
      }
      state.project = data.project;
      state.materialLists = Array.isArray(data.materialLists) ? data.materialLists : [];
      els.loading.hidden = true;
      els.page.hidden = false;
      els.savebar.hidden = false;
      // Fetch the WOs that the project lists so we can render their status
      // pills and customer info inline. Single fetch over /api/work-orders;
      // filter client-side for the ids we want.
      await refreshAttachedWos();
      renderAll();
      setSaveState("saved", state.project.updatedAt);
    } catch (err) {
      showError(err.message || "Couldn't load project.");
    }
  }

  async function refreshAttachedWos() {
    const ids = state.project.workOrderIds || [];
    if (!ids.length) { state.workOrders = new Map(); return; }
    try {
      const r = await fetch("/api/work-orders", { cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      const all = (data.ok && Array.isArray(data.workOrders)) ? data.workOrders : [];
      state.workOrders = new Map(all.filter((w) => ids.includes(w.id)).map((w) => [w.id, w]));
    } catch {
      state.workOrders = new Map();
    }
  }

  // ---- Render -------------------------------------------------------
  function renderAll() {
    renderHeader();
    renderWos();
    renderMls();
  }

  function renderHeader() {
    els.id.textContent = state.project.id;
    els.status.className = `proj-status proj-status--${state.project.status}`;
    els.status.textContent = STATUS_LABELS[state.project.status] || state.project.status;
    els.statusSelect.value = state.project.status;

    if (state.project.sourceQuoteId) {
      els.source.hidden = false;
      els.source.innerHTML = `Converted from <a href="/admin/quote-folder">${escapeHtml(state.project.sourceQuoteId)}</a>`;
    } else {
      els.source.hidden = true;
    }

    setIfNotFocused(els.name, state.project.name);
    setIfNotFocused(els.customerName, state.project.customerName);
    setIfNotFocused(els.customerEmail, state.project.customerEmail);
    setIfNotFocused(els.customerPhone, state.project.customerPhone);
    setIfNotFocused(els.propertyId, state.project.propertyId || "");
    setIfNotFocused(els.address, state.project.address);
    setIfNotFocused(els.description, state.project.description);
    setIfNotFocused(els.notes, state.project.notes);
  }
  function setIfNotFocused(el, value) {
    if (document.activeElement !== el) el.value = value || "";
  }

  function renderWos() {
    const ids = state.project.workOrderIds || [];
    if (!ids.length) {
      els.wosEmpty.hidden = false;
      els.wosList.innerHTML = "";
      return;
    }
    els.wosEmpty.hidden = true;
    els.wosList.innerHTML = ids.map((id) => {
      const wo = state.workOrders.get(id);
      const status = wo ? (WO_STATUS_LABELS[wo.status] || wo.status) : "—";
      const customer = wo ? (wo.customerName || "(no customer)") : "(WO not found)";
      const date = wo && wo.scheduledFor ? fmtDate(wo.scheduledFor) : (wo ? "" : "");
      return `
        <li>
          <div class="proj-row" data-wo-id="${escapeHtml(id)}">
            <a class="proj-row-info" href="/admin/work-order/${encodeURIComponent(id)}" style="text-decoration:none;color:inherit">
              <div class="proj-row-title">${escapeHtml(customer)}</div>
              <div class="proj-row-meta">
                <span class="proj-row-id">${escapeHtml(id)}</span>
                ${wo && wo.type ? `<span>${escapeHtml(wo.type.replace(/_/g, " "))}</span>` : ""}
                ${date ? `<span>${escapeHtml(date)}</span>` : ""}
                <span>${escapeHtml(status)}</span>
              </div>
            </a>
            <div class="proj-row-end">
              <button type="button" class="proj-row-detach" data-action="detach-wo" aria-label="Detach work order">×</button>
            </div>
          </div>
        </li>
      `;
    }).join("");
  }

  function renderMls() {
    const lists = state.materialLists || [];
    if (!lists.length) {
      els.mlsEmpty.hidden = false;
      els.mlsList.innerHTML = "";
      return;
    }
    els.mlsEmpty.hidden = true;
    els.mlsList.innerHTML = lists.map((rec) => {
      const totals = rec.totals || {};
      const status = ML_STATUS_LABELS[rec.status] || rec.status;
      return `
        <li>
          <a class="proj-row" href="/admin/material-list/${encodeURIComponent(rec.id)}">
            <div class="proj-row-info">
              <div class="proj-row-title">${escapeHtml(rec.name || "(untitled list)")}</div>
              <div class="proj-row-meta">
                <span class="proj-row-id">${escapeHtml(rec.id)}</span>
                <span class="ml-status ml-status--${escapeHtml(rec.status)}">${escapeHtml(status)}</span>
                <span>${totals.lineCount || 0} lines</span>
                ${totals.needCount ? `<span style="color:#7A5500">${totals.needCount} need</span>` : ""}
                ${totals.haveCount ? `<span style="color:#1B4D2E">${totals.haveCount} have</span>` : ""}
              </div>
            </div>
            <div class="proj-row-end">
              <span style="font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:700;color:#1B4D2E">${fmtCents(totals.grandSubtotalCents)}</span>
            </div>
          </a>
        </li>
      `;
    }).join("");
  }

  // ---- Save ---------------------------------------------------------
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
      els.saveState.textContent = "Unsaved changes";
    }
  }
  setInterval(() => {
    if (els.saveState.classList.contains("is-saved") && state.lastSavedAt) {
      els.saveState.textContent = `Saved · ${relTime(state.lastSavedAt)}`;
    }
  }, 5000);

  function scheduleSave(immediate = false) {
    setSaveState("dirty");
    if (state.saveTimer) clearTimeout(state.saveTimer);
    if (immediate) { flushSave(); return; }
    state.saveTimer = setTimeout(flushSave, 1200);
  }
  async function flushSave() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    if (state.saving) { state.saveTimer = setTimeout(flushSave, 200); return; }
    state.saving = true;
    setSaveState("saving");
    state.pendingError = null;
    try {
      const payload = {
        name: state.project.name,
        customerName: state.project.customerName,
        customerEmail: state.project.customerEmail,
        customerPhone: state.project.customerPhone,
        propertyId: state.project.propertyId,
        address: state.project.address,
        description: state.project.description,
        notes: state.project.notes,
        status: state.project.status
      };
      const r = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        state.pendingError = (data.errors && data.errors[0]) || `Save failed (${r.status})`;
        setSaveState("error");
        return;
      }
      state.project = data.project;
      renderHeader();
      setSaveState("saved", state.project.updatedAt);
    } catch (err) {
      state.pendingError = err.message || "Save failed";
      setSaveState("error");
    } finally {
      state.saving = false;
    }
  }

  function bindFieldInput(input, fieldName) {
    input.addEventListener("input", () => {
      state.project[fieldName] = input.value;
      scheduleSave();
    });
    input.addEventListener("blur", () => {
      if (state.saveTimer || state.pendingError) flushSave();
    });
  }

  // ---- Attach-WO modal ---------------------------------------------
  async function loadWoSearchCache() {
    if (state.woSearchCache) return state.woSearchCache;
    const r = await fetch("/api/work-orders", { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    state.woSearchCache = (data.ok && Array.isArray(data.workOrders)) ? data.workOrders : [];
    return state.woSearchCache;
  }
  function renderWoSearchResults(query) {
    const all = state.woSearchCache || [];
    const q = String(query || "").trim().toLowerCase();
    const filtered = q
      ? all.filter((w) => [w.id, w.customerName, w.customerEmail, w.address].map((v) => String(v || "").toLowerCase()).join(" ").includes(q))
      : all.slice(0, 30);
    const attached = new Set(state.project.workOrderIds || []);
    if (!filtered.length) {
      els.attachWoResults.innerHTML = `<p class="proj-empty">No matching work orders.</p>`;
      return;
    }
    els.attachWoResults.innerHTML = filtered.slice(0, 30).map((w) => {
      const isAttached = attached.has(w.id);
      const status = WO_STATUS_LABELS[w.status] || w.status;
      return `
        <button type="button" class="proj-modal-row ${isAttached ? "is-disabled" : ""}" data-wo-id="${escapeHtml(w.id)}" ${isAttached ? "disabled" : ""}>
          <div>
            <div style="font-weight:600;color:#1F2A22">${escapeHtml(w.customerName || "(no customer)")}</div>
            <div style="font-size:12px;color:#7A7A72;font-family:ui-monospace,monospace">${escapeHtml(w.id)} &middot; ${escapeHtml(status)}${w.scheduledFor ? " &middot; " + escapeHtml(fmtDate(w.scheduledFor)) : ""}</div>
          </div>
          <span style="font-size:12px;color:#7A7A72">${isAttached ? "attached" : "+ attach"}</span>
        </button>
      `;
    }).join("");
  }
  async function openAttachWoModal() {
    els.attachWoModal.hidden = false;
    els.attachWoResults.innerHTML = `<p class="proj-empty">Loading work orders…</p>`;
    await loadWoSearchCache();
    renderWoSearchResults("");
    setTimeout(() => els.attachWoSearch.focus(), 100);
  }
  function closeAttachWoModal() {
    els.attachWoModal.hidden = true;
    els.attachWoSearch.value = "";
  }

  // ---- Mutations ----------------------------------------------------
  async function attachWo(woId) {
    const r = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/attach-work-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workOrderId: woId })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      alert((data.errors && data.errors[0]) || "Couldn't attach work order.");
      return;
    }
    state.project = data.project;
    closeAttachWoModal();
    await refreshAttachedWos();
    renderAll();
    setSaveState("saved", state.project.updatedAt);
  }
  async function detachWo(woId) {
    if (!confirm("Detach this work order from the project? The WO itself stays put.")) return;
    const r = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/detach-work-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workOrderId: woId })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      alert((data.errors && data.errors[0]) || "Couldn't detach work order.");
      return;
    }
    state.project = data.project;
    await refreshAttachedWos();
    renderAll();
    setSaveState("saved", state.project.updatedAt);
  }

  async function createMaterialList() {
    // POST a new ML pre-attached to this project. Server stamps the id +
    // copies what we send; we redirect into the builder for the user to
    // start adding line items.
    const r = await fetch("/api/material-lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.project.name ? `${state.project.name} — materials` : "Untitled material list",
        parentType: "project",
        parentId: state.project.id,
        customerName: state.project.customerName,
        customerEmail: state.project.customerEmail,
        address: state.project.address
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      alert((data.errors && data.errors[0]) || "Couldn't create material list.");
      return;
    }
    location.href = `/admin/material-list/${encodeURIComponent(data.list.id)}`;
  }

  async function archiveProject() {
    const archiving = state.project.status !== "archived";
    if (!confirm(archiving ? "Archive this project?" : "Restore this project from archive?")) return;
    state.project.status = archiving ? "archived" : "planning";
    flushSave();
  }
  async function deleteProject() {
    const lineCount = (state.materialLists || []).length;
    const confirmText = lineCount
      ? `Delete this project? Its ${lineCount} attached material list${lineCount === 1 ? "" : "s"} will be detached but not deleted.`
      : "Delete this empty project?";
    if (!confirm(confirmText)) return;
    const r = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}`, { method: "DELETE" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      alert((data.errors && data.errors[0]) || "Couldn't delete project.");
      return;
    }
    location.href = "/admin/projects";
  }

  // ---- Wire up ------------------------------------------------------
  function wire() {
    bindFieldInput(els.name, "name");
    bindFieldInput(els.customerName, "customerName");
    bindFieldInput(els.customerEmail, "customerEmail");
    bindFieldInput(els.customerPhone, "customerPhone");
    bindFieldInput(els.propertyId, "propertyId");
    bindFieldInput(els.address, "address");
    bindFieldInput(els.description, "description");
    bindFieldInput(els.notes, "notes");

    els.statusSelect.addEventListener("change", () => {
      state.project.status = els.statusSelect.value;
      scheduleSave(true);
    });

    els.attachWoButton.addEventListener("click", openAttachWoModal);
    els.attachWoCancel.addEventListener("click", closeAttachWoModal);
    els.attachWoModal.addEventListener("click", (event) => {
      if (event.target === els.attachWoModal) closeAttachWoModal();
    });
    els.attachWoSearch.addEventListener("input", () => renderWoSearchResults(els.attachWoSearch.value));
    els.attachWoResults.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-wo-id]");
      if (!btn || btn.disabled) return;
      attachWo(btn.dataset.woId);
    });

    els.wosList.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action='detach-wo']");
      if (!btn) return;
      const row = event.target.closest("[data-wo-id]");
      if (row) detachWo(row.dataset.woId);
    });

    els.newMaterialListButton.addEventListener("click", createMaterialList);
    els.archiveButton.addEventListener("click", archiveProject);
    els.deleteButton.addEventListener("click", deleteProject);

    window.addEventListener("beforeunload", () => {
      if (!state.saveTimer && !state.pendingError) return;
      try {
        fetch(`/api/projects/${encodeURIComponent(state.projectId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: state.project.name,
            customerName: state.project.customerName,
            customerEmail: state.project.customerEmail,
            customerPhone: state.project.customerPhone,
            propertyId: state.project.propertyId,
            address: state.project.address,
            description: state.project.description,
            notes: state.project.notes,
            status: state.project.status
          }),
          keepalive: true
        });
      } catch {}
    });
  }

  wire();
  boot();
})();
