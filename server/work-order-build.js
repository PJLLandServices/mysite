// Brief 2 — Build-mode WO UI bridge. Loaded from both work-order.html
// (desktop) and work-order-tech.html (mobile). Detects type === "build"
// at boot, loads project + parts + project-rates contexts, wires up
// session/task/material/notes/next-day/scope cards.
//
// Coexists with the existing work-order.js / work-order-tech.js — those
// modules render the spring/fall/service surfaces. When build-mode, the
// build panel becomes the primary surface and the existing surfaces stay
// visible but largely irrelevant (no zone grid for builds, etc.).

(function () {
  "use strict";

  // Pull the WO id from the URL — same pattern as the parent modules.
  const idMatch = location.pathname.match(/^\/admin\/work-order\/([^/]+)/);
  if (!idMatch) return;
  const WO_ID = decodeURIComponent(idMatch[1]);

  const panel = document.getElementById("techBuildPanel");
  if (!panel) return; // build panel not present (different page or template version)

  const $ = (id) => document.getElementById(id);
  const els = {
    panel,
    projectName: $("tbProjectName"),
    projectMeta: $("tbProjectMeta"),
    projectLink: $("tbProjectLink"),
    sessionState: $("tbSessionState"),
    startSession: $("tbStartSession"),
    endSession: $("tbEndSession"),
    labourersBlock: $("tbLabourersBlock"),
    labourersCount: $("tbLabourersCount"),
    labourerNote: $("tbLabourerNote"),
    sessionList: $("tbSessionList"),
    taskList: $("tbTaskList"),
    addMaterialsBtn: $("tbAddMaterialsBtn"),
    materialsList: $("tbMaterialsList"),
    dailyNotes: $("tbDailyNotes"),
    dailyNotesSaveState: $("tbDailyNotesSaveState"),
    nextDayTasks: $("tbNextDayTasks"),
    addScopeBtn: $("tbAddScopeBtn"),
    materialsModal: $("tbMaterialsModal"),
    materialsSearch: $("tbMaterialsSearch"),
    materialsCatalog: $("tbMaterialsCatalog"),
    materialsSummary: $("tbMaterialsSummary"),
    materialsCancel: $("tbMaterialsCancel"),
    materialsConfirm: $("tbMaterialsConfirm"),
    scopeModal: $("tbScopeModal"),
    scopeDescription: $("tbScopeDescription"),
    scopeCatalog: $("tbScopeCatalog"),
    scopeSummary: $("tbScopeSummary"),
    scopeCancel: $("tbScopeCancel"),
    scopeSave: $("tbScopeSave")
  };

  const state = {
    wo: null,
    project: null,
    parts: null,           // parts.json catalog
    projectRates: null,    // project-rates.json catalog (for scope additions)
    materialsDraft: {},    // partSku → qty in the modal
    scopeDraft: { description: "", suggestedLineItems: [] },
    notesSaveTimer: null,
    nextDaySaveTimer: null
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  async function boot() {
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}`, { cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      if (!data.ok || !data.workOrder) return;
      state.wo = data.workOrder;
      if (state.wo.type !== "build") return; // not a build WO — leave panel hidden
      els.panel.hidden = false;
      // Load project + catalogs in parallel.
      const [projRes, partsRes, ratesRes] = await Promise.all([
        state.wo.parentProjectId
          ? fetch(`/api/projects/${encodeURIComponent(state.wo.parentProjectId)}`).then((r) => r.ok ? r.json() : null).catch(() => null)
          : Promise.resolve(null),
        fetch("/api/parts", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch("/api/admin/project-rates", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null)
      ]);
      state.project = projRes?.project || null;
      state.parts = partsRes?.parts || null;
      state.projectRates = ratesRes?.projectRates || null;

      renderContext();
      renderSession();
      renderTasks();
      renderMaterials();
      renderNotes();
      renderNextDay();
      wire();
    } catch (err) {
      console.warn("[wo-build] boot failed:", err?.message);
    }
  }

  function renderContext() {
    if (!state.project) {
      els.projectName.textContent = "(no project linked)";
      return;
    }
    els.projectName.textContent = state.project.name || state.project.id;
    const tasks = state.project.tasks || [];
    const done = tasks.filter((t) => t.status === "done").length;
    const dateStr = state.wo.dailyLog?.workDate
      ? new Date(state.wo.dailyLog.workDate + "T12:00:00").toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" })
      : "—";
    els.projectMeta.textContent = `${dateStr} · ${done}/${tasks.length} tasks complete · ${state.project.billingMode === "time_and_material" ? "T&M billing" : "Fixed price"}`;
    els.projectLink.href = `/admin/project/${encodeURIComponent(state.project.id)}`;
  }

  function renderSession() {
    const sessions = state.wo.dailyLog?.sessions || [];
    const active = sessions.find((s) => !s.outAt);
    if (active) {
      const start = new Date(active.inAt);
      els.sessionState.textContent = `Active since ${start.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })} · ${active.labourersOnSite} labourer${active.labourersOnSite === 1 ? "" : "s"}`;
      els.startSession.hidden = true;
      els.endSession.hidden = false;
      els.labourersBlock.hidden = false;
      els.labourersCount.value = active.labourersOnSite;
      els.labourerNote.value = active.labourerNote || "";
    } else {
      els.sessionState.textContent = sessions.length ? `${sessions.length} session${sessions.length === 1 ? "" : "s"} closed today` : "Not started";
      els.startSession.hidden = false;
      els.endSession.hidden = true;
      els.labourersBlock.hidden = sessions.length === 0;
      if (sessions.length) {
        els.labourersCount.value = sessions[sessions.length - 1].labourersOnSite;
      }
    }
    els.sessionList.innerHTML = sessions.map((s) => {
      const start = new Date(s.inAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
      const end = s.outAt
        ? new Date(s.outAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })
        : "active";
      const hours = s.outAt ? ((new Date(s.outAt) - new Date(s.inAt)) / 3600000).toFixed(2) : "—";
      return `<li class="tech-build-session-item">${escapeHtml(start)} → ${escapeHtml(end)} · ${escapeHtml(s.labourersOnSite)}×${escapeHtml(hours)}h${s.labourerNote ? ` · ${escapeHtml(s.labourerNote)}` : ""}</li>`;
    }).join("");
  }

  function renderTasks() {
    if (!state.project) {
      els.taskList.innerHTML = `<li class="tech-build-empty">(no project linked)</li>`;
      return;
    }
    const tasks = (state.project.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const doneToday = new Set((state.wo.dailyLog?.tasksCompletedToday || []).map((t) => t.taskId));
    if (!tasks.length) {
      els.taskList.innerHTML = `<li class="tech-build-empty">No tasks defined on this project.</li>`;
      return;
    }
    els.taskList.innerHTML = tasks.map((t) => {
      const isDone = t.status === "done";
      const isDoneHere = doneToday.has(t.id);
      const checkbox = isDone
        ? `<span class="tech-build-task-check tech-build-task-check--done" aria-hidden="true">✓</span>`
        : `<button type="button" class="tech-build-task-mark" data-task-id="${escapeHtml(t.id)}">Mark done today</button>`;
      const doneHereTag = isDone && isDoneHere
        ? `<span class="tech-build-task-tag">today</span>`
        : isDone && t.completedByWoId !== state.wo.id
          ? `<span class="tech-build-task-tag tech-build-task-tag--other">${escapeHtml(t.completedByWoId || "—")}</span>`
          : "";
      return `
        <li class="tech-build-task-item${isDone ? " is-done" : ""}" data-task-id="${escapeHtml(t.id)}">
          ${checkbox}
          <span class="tech-build-task-desc">${escapeHtml(t.description)}</span>
          ${doneHereTag}
        </li>
      `;
    }).join("");
    els.taskList.querySelectorAll(".tech-build-task-mark").forEach((btn) => {
      btn.addEventListener("click", () => markTaskDone(btn.dataset.taskId));
    });
  }

  function renderMaterials() {
    const items = state.wo.dailyLog?.materialsConsumed || [];
    if (!items.length) {
      els.materialsList.innerHTML = `<li class="tech-build-empty">No materials recorded yet.</li>`;
      return;
    }
    const carried = state.wo.dailyLog?._carriedMaterials || [];
    let html = "";
    if (carried.length) {
      html += `<li class="tech-build-carried"><strong>Carried over from yesterday:</strong> ${carried.map((c) => `${escapeHtml(c.partSku)}×${c.qty}`).join(", ")}</li>`;
    }
    html += items.map((m, idx) => {
      const part = state.parts?.[m.partSku] || state.parts?.parts?.[m.partSku];
      const label = part?.label || part?.name || m.partSku;
      return `
        <li class="tech-build-material-item" data-idx="${idx}">
          <span class="tech-build-material-label">${escapeHtml(label)}</span>
          <span class="tech-build-material-qty">× ${escapeHtml(m.qty)}</span>
          <button type="button" class="tech-build-material-remove" data-idx="${idx}" aria-label="Remove">×</button>
        </li>
      `;
    }).join("");
    els.materialsList.innerHTML = html;
    els.materialsList.querySelectorAll(".tech-build-material-remove").forEach((btn) => {
      btn.addEventListener("click", () => removeMaterial(Number(btn.dataset.idx)));
    });
  }

  function renderNotes() {
    els.dailyNotes.value = state.wo.dailyLog?.dailyNotes || "";
  }

  function renderNextDay() {
    const tasks = state.wo.dailyLog?.nextDayTasks || [];
    els.nextDayTasks.value = tasks.join("\n");
  }

  // ---- Actions ----

  async function startSession() {
    const count = parseInt(els.labourersCount.value, 10);
    const note = els.labourerNote.value.trim();
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          labourersOnSite: Number.isFinite(count) && count > 0 ? count : 1,
          labourerNote: note
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        alert(data.errors?.[0] || `Start failed (${r.status})`);
        return;
      }
      state.wo = data.workOrder;
      renderSession();
    } catch (err) { alert(err.message || "Start failed."); }
  }

  async function endSession() {
    const sessions = state.wo.dailyLog?.sessions || [];
    const active = sessions.find((s) => !s.outAt);
    if (!active) return;
    if (!confirm(`End session ${active.id}?`)) return;
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/sessions/${encodeURIComponent(active.id)}/end`, {
        method: "PATCH"
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        alert(data.errors?.[0] || `End failed (${r.status})`);
        return;
      }
      state.wo = data.workOrder;
      renderSession();
    } catch (err) { alert(err.message || "End failed."); }
  }

  async function updateLabourers() {
    const sessions = state.wo.dailyLog?.sessions || [];
    if (!sessions.length) return;
    const target = sessions.find((s) => !s.outAt) || sessions[sessions.length - 1];
    const count = parseInt(els.labourersCount.value, 10);
    const note = els.labourerNote.value.trim();
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/sessions/${encodeURIComponent(target.id)}/labourers`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: Number.isFinite(count) && count > 0 ? count : 1, note })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) return;
      state.wo = data.workOrder;
      renderSession();
    } catch (_) {}
  }

  async function markTaskDone(taskId) {
    if (!confirm("Mark this task done? Updates the project's master list.")) return;
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/tasks-done`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        alert(data.errors?.[0] || `Mark failed (${r.status})`);
        return;
      }
      // Refresh project to get updated task state.
      const [woR, projR] = await Promise.all([
        fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}`).then((r) => r.json()),
        state.wo.parentProjectId
          ? fetch(`/api/projects/${encodeURIComponent(state.wo.parentProjectId)}`).then((r) => r.json())
          : Promise.resolve(null)
      ]);
      state.wo = woR.workOrder;
      if (projR?.project) state.project = projR.project;
      renderTasks();
      renderContext();
    } catch (err) { alert(err.message || "Mark failed."); }
  }

  async function removeMaterial(idx) {
    if (!confirm("Remove this material entry?")) return;
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/materials-consumed/${idx}`, {
        method: "DELETE"
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) return;
      state.wo = data.workOrder;
      renderMaterials();
    } catch (_) {}
  }

  // Materials modal — catalog batch picker from parts.json.
  function openMaterialsModal() {
    state.materialsDraft = {};
    els.materialsSearch.value = "";
    renderMaterialsCatalog("");
    els.materialsModal.hidden = false;
  }
  function closeMaterialsModal() { els.materialsModal.hidden = true; }
  function renderMaterialsCatalog(search) {
    const parts = state.parts?.parts || state.parts || {};
    const needle = String(search || "").toLowerCase();
    const entries = Object.entries(parts).filter(([sku, part]) => {
      if (!part) return false;
      if (!needle) return true;
      const label = String(part.label || part.name || sku).toLowerCase();
      return sku.toLowerCase().includes(needle) || label.includes(needle);
    }).slice(0, 100);
    els.materialsCatalog.innerHTML = entries.map(([sku, part]) => {
      const label = part.label || part.name || sku;
      const qty = state.materialsDraft[sku] || 0;
      return `
        <div class="tech-modal-catalog-row" data-sku="${escapeHtml(sku)}">
          <div class="tech-modal-catalog-label">${escapeHtml(label)}</div>
          <input type="number" class="tech-modal-catalog-qty" data-sku="${escapeHtml(sku)}" min="0" step="1" value="${qty}">
        </div>
      `;
    }).join("");
    els.materialsCatalog.querySelectorAll(".tech-modal-catalog-qty").forEach((input) => {
      input.addEventListener("input", () => {
        const sku = input.dataset.sku;
        const q = parseFloat(input.value);
        if (Number.isFinite(q) && q > 0) state.materialsDraft[sku] = q;
        else delete state.materialsDraft[sku];
        updateMaterialsSummary();
      });
    });
    updateMaterialsSummary();
  }
  function updateMaterialsSummary() {
    const entries = Object.entries(state.materialsDraft);
    if (!entries.length) {
      els.materialsSummary.textContent = "No items selected.";
      return;
    }
    els.materialsSummary.textContent = `${entries.length} item${entries.length === 1 ? "" : "s"} · ${entries.reduce((sum, [, q]) => sum + Number(q), 0)} total qty`;
  }
  async function confirmMaterials() {
    const items = Object.entries(state.materialsDraft).map(([partSku, qty]) => ({ partSku, qty }));
    if (!items.length) { closeMaterialsModal(); return; }
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/materials-consumed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        alert(data.errors?.[0] || "Add failed.");
        return;
      }
      state.wo = data.workOrder;
      closeMaterialsModal();
      renderMaterials();
    } catch (err) { alert(err.message || "Add failed."); }
  }

  // Daily notes save — debounced.
  function scheduleNotesSave() {
    if (state.notesSaveTimer) clearTimeout(state.notesSaveTimer);
    els.dailyNotesSaveState.textContent = "Saving…";
    state.notesSaveTimer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/daily-notes`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dailyNotes: els.dailyNotes.value })
        });
        const data = await r.json().catch(() => ({}));
        if (data.ok) {
          state.wo = data.workOrder;
          els.dailyNotesSaveState.textContent = "Saved.";
        } else {
          els.dailyNotesSaveState.textContent = "Save failed.";
        }
      } catch (_) {
        els.dailyNotesSaveState.textContent = "Save failed.";
      }
    }, 600);
  }

  // Next-day plan save — debounced.
  function scheduleNextDaySave() {
    if (state.nextDaySaveTimer) clearTimeout(state.nextDaySaveTimer);
    state.nextDaySaveTimer = setTimeout(async () => {
      const taskLines = els.nextDayTasks.value.split("\n").map((s) => s.trim()).filter(Boolean);
      try {
        const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/next-day`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nextDayTasks: taskLines,
            // Materials carry-over comes from today's consumed in the
            // create endpoint; tomorrow's pack list could also be set
            // here but v1 keeps it task-only at the WO level.
            nextDayMaterials: state.wo.dailyLog?.nextDayMaterials || []
          })
        });
        const data = await r.json().catch(() => ({}));
        if (data.ok) state.wo = data.workOrder;
      } catch (_) {}
    }, 600);
  }

  // Scope addition modal — catalog batch picker from project-rates.json.
  function openScopeModal() {
    state.scopeDraft = { description: "", suggestedLineItems: [] };
    els.scopeDescription.value = "";
    renderScopeCatalog();
    els.scopeModal.hidden = false;
  }
  function closeScopeModal() { els.scopeModal.hidden = true; }
  function renderScopeCatalog() {
    const items = state.projectRates?.items || {};
    els.scopeCatalog.innerHTML = Object.entries(items).map(([key, item]) => `
      <div class="tech-modal-catalog-row" data-sku="${escapeHtml(key)}">
        <div class="tech-modal-catalog-label">${escapeHtml(item.label)}</div>
        <div class="tech-modal-catalog-price">$${Number(item.price).toFixed(2)}/${item.unit || "unit"}</div>
        <input type="number" class="tech-modal-catalog-qty" data-sku="${escapeHtml(key)}" min="0" step="0.01" value="0">
      </div>
    `).join("");
    els.scopeCatalog.querySelectorAll(".tech-modal-catalog-qty").forEach((input) => {
      input.addEventListener("input", () => updateScopeSummary());
    });
    updateScopeSummary();
  }
  function updateScopeSummary() {
    const inputs = els.scopeCatalog.querySelectorAll(".tech-modal-catalog-qty");
    const items = state.projectRates?.items || {};
    const selected = [];
    inputs.forEach((input) => {
      const qty = parseFloat(input.value);
      if (!Number.isFinite(qty) || qty <= 0) return;
      const sku = input.dataset.sku;
      const item = items[sku];
      if (!item) return;
      selected.push({
        source: "project_rates",
        sourceKey: sku,
        label: item.label,
        unit: item.unit || "",
        qty,
        price: Number(item.price) || 0,
        lineTotal: Math.round(qty * (Number(item.price) || 0) * 100) / 100
      });
    });
    state.scopeDraft.suggestedLineItems = selected;
    const total = selected.reduce((sum, s) => sum + s.lineTotal, 0);
    els.scopeSummary.textContent = selected.length
      ? `${selected.length} item${selected.length === 1 ? "" : "s"} · estimated $${total.toFixed(2)}`
      : `Estimated $0.00`;
  }
  async function saveScope() {
    const description = els.scopeDescription.value.trim();
    if (!description) { alert("Description required."); return; }
    if (!state.project) { alert("This WO has no parent project."); return; }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.project.id)}/scope-changes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description,
          capturedFromWoId: WO_ID,
          suggestedLineItems: state.scopeDraft.suggestedLineItems
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) { alert(data.errors?.[0] || "Save failed."); return; }
      closeScopeModal();
      alert(`Scope addition ${data.scopeChange.id} saved. Review and send from the project page.`);
    } catch (err) { alert(err.message || "Save failed."); }
  }

  function wire() {
    els.startSession.addEventListener("click", startSession);
    els.endSession.addEventListener("click", endSession);
    els.labourersCount.addEventListener("change", updateLabourers);
    els.labourerNote.addEventListener("change", updateLabourers);

    els.addMaterialsBtn.addEventListener("click", openMaterialsModal);
    els.materialsCancel.addEventListener("click", closeMaterialsModal);
    els.materialsConfirm.addEventListener("click", confirmMaterials);
    els.materialsSearch.addEventListener("input", () => renderMaterialsCatalog(els.materialsSearch.value));
    els.materialsModal.addEventListener("click", (e) => { if (e.target === els.materialsModal) closeMaterialsModal(); });

    els.dailyNotes.addEventListener("input", scheduleNotesSave);
    els.nextDayTasks.addEventListener("input", scheduleNextDaySave);

    els.addScopeBtn.addEventListener("click", openScopeModal);
    els.scopeCancel.addEventListener("click", closeScopeModal);
    els.scopeSave.addEventListener("click", saveScope);
    els.scopeModal.addEventListener("click", (e) => { if (e.target === els.scopeModal) closeScopeModal(); });
  }

  boot();
})();
