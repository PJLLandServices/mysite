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

  // Brief 2 — dynamic toast (no host-page HTML dependency). Replaces
  // alert() for non-trivial result messages. confirm() is allowed for
  // trivial delete confirms per brief; non-trivial confirms get an
  // inline modal injected on demand.
  let _toastEl = null;
  let _toastTimer = null;
  function ensureToastEl() {
    if (_toastEl && document.body.contains(_toastEl)) return _toastEl;
    const t = document.createElement("div");
    t.id = "tbToast";
    t.style.cssText = "position:fixed;bottom:calc(20px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);background:#1B4D2E;color:#fff;padding:12px 18px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.25);font:600 14px system-ui;z-index:9999;max-width:90vw;text-align:center;display:none;";
    document.body.appendChild(t);
    _toastEl = t;
    return t;
  }
  function showToast(msg, { variant = "info", durationMs = 4000 } = {}) {
    const t = ensureToastEl();
    t.textContent = msg;
    t.style.background = variant === "error" ? "#842F1B" : variant === "success" ? "#1B4D2E" : "#1B4D2E";
    t.style.display = "block";
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.style.display = "none"; }, durationMs);
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
      btn.addEventListener("click", () => openTaskDoneModal(btn.dataset.taskId));
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
      const label = partLabel(part, m.partSku);
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
    renderNextDayMats();
  }

  function renderNextDayMats() {
    const list = document.getElementById("tbNextDayMatsList");
    const promoteBtn = document.getElementById("tbPromoteNextDayMatsBtn");
    if (!list) return;
    const mats = state.wo.dailyLog?.nextDayMaterials || [];
    if (!mats.length) {
      list.innerHTML = "";
      if (promoteBtn) promoteBtn.hidden = true;
      return;
    }
    list.innerHTML = mats.map((m, idx) => {
      const part = state.parts?.[m.partSku] || state.parts?.parts?.[m.partSku];
      const label = partLabel(part, m.partSku);
      return `<li class="tech-build-material-item" data-idx="${idx}"><span class="tech-build-material-label">${escapeHtml(label)}</span><span class="tech-build-material-qty">× ${escapeHtml(m.qty)}</span><button type="button" class="tech-build-material-remove" data-nextday-idx="${idx}" aria-label="Remove">×</button></li>`;
    }).join("");
    list.querySelectorAll("[data-nextday-idx]").forEach((btn) => {
      btn.addEventListener("click", () => removeNextDayMat(Number(btn.dataset.nextdayIdx)));
    });
    if (promoteBtn) promoteBtn.hidden = false;
  }

  async function removeNextDayMat(idx) {
    const mats = (state.wo.dailyLog?.nextDayMaterials || []).slice();
    mats.splice(idx, 1);
    await saveNextDayMats(mats);
  }

  async function saveNextDayMats(mats) {
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/next-day`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nextDayMaterials: mats,
          nextDayTasks: (els.nextDayTasks.value || "").split("\n").map((s) => s.trim()).filter(Boolean)
        })
      });
      const data = await r.json().catch(() => ({}));
      if (data.ok) {
        state.wo = data.workOrder;
        renderNextDayMats();
      }
    } catch (_) {}
  }

  // Tomorrow's materials picker — same catalog batch UX as the "Materials
  // consumed today" picker, just writes to nextDayMaterials instead.
  let _nextDayMatsDraft = {};
  function openNextDayMatsModal() {
    _nextDayMatsDraft = {};
    // Re-use the materials modal HTML but stamp a flag so confirm goes
    // to next-day path. Simpler than building a parallel modal.
    state._nextDayMatsMode = true;
    state.materialsDraft = {};
    document.getElementById("tbMaterialsSearch").value = "";
    renderMaterialsCatalog("");
    document.querySelector("#tbMaterialsModal h3").textContent = "Add tomorrow's materials";
    els.materialsModal.hidden = false;
  }

  async function confirmNextDayMats() {
    const items = Object.entries(state.materialsDraft).map(([partSku, qty]) => ({ partSku, qty }));
    if (!items.length) { closeMaterialsModal(); return; }
    const existing = state.wo.dailyLog?.nextDayMaterials || [];
    await saveNextDayMats([...existing, ...items.map((i) => ({ ...i, addedAt: new Date().toISOString(), note: "" }))]);
    state._nextDayMatsMode = false;
    document.querySelector("#tbMaterialsModal h3").textContent = "Add materials consumed";
    closeMaterialsModal();
    showToast(`Added ${items.length} item${items.length === 1 ? "" : "s"} to tomorrow's pack.`, { variant: "success" });
  }

  async function promoteNextDayMats() {
    const mats = state.wo.dailyLog?.nextDayMaterials || [];
    if (!mats.length || !state.project) return;
    if (!confirm(`Promote ${mats.length} item${mats.length === 1 ? "" : "s"} to a project material list?`)) return;
    try {
      // Create a material list under the project. material-lists.js
      // expects `lineItems` (not `items`) with shape { sku, qty,
      // status, notes } — earlier code sent `items` + `partSku` which
      // got silently dropped and produced an empty list. The fix maps
      // partSku → sku and items → lineItems.
      const r = await fetch("/api/material-lists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Day-pack for ${state.wo.dailyLog?.workDate || "tomorrow"} (${state.wo.id})`,
          parentType: "project",
          parentId: state.project.id,
          customerName: state.project.customerName,
          customerEmail: state.project.customerEmail,
          address: state.project.address,
          notes: `Promoted from WO ${state.wo.id} tomorrow's pack on ${new Date().toLocaleDateString("en-CA")}.`,
          lineItems: mats.map((m) => ({
            sku: m.partSku,
            qty: Math.max(1, Math.floor(Number(m.qty) || 1)),
            status: "need",
            notes: m.note || ""
          }))
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showToast(data.errors?.[0] || "Promote failed.", { variant: "error" });
        return;
      }
      const newId = data.list?.id;
      const lineCount = (data.list?.lineItems || []).length;
      showToast(`Material list ${newId} created with ${lineCount} item${lineCount === 1 ? "" : "s"}.`, { variant: "success", durationMs: 6000 });
      // Open the new list so admin can finalize / order.
      if (newId) {
        setTimeout(() => { location.href = `/admin/material-list/${encodeURIComponent(newId)}`; }, 1200);
      }
    } catch (err) { showToast(err.message || "Promote failed.", { variant: "error" }); }
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
        showToast(data.errors?.[0] || `Start failed (${r.status})`, { variant: "error" });
        return;
      }
      state.wo = data.workOrder;
      renderSession();
      const lc = data.session?.labourersOnSite || 1;
      showToast(`Session started · ${lc} labourer${lc === 1 ? "" : "s"}`, { variant: "success" });
    } catch (err) { showToast(err.message || "Start failed.", { variant: "error" }); }
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
        showToast(data.errors?.[0] || `End failed (${r.status})`, { variant: "error" });
        return;
      }
      state.wo = data.workOrder;
      renderSession();
      showToast("Session ended.", { variant: "success" });
    } catch (err) { showToast(err.message || "End failed.", { variant: "error" }); }
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

  // Open the mark-done modal, which lets the tech attach photos.
  let _taskDonePending = null;
  function openTaskDoneModal(taskId) {
    const task = (state.project?.tasks || []).find((t) => t.id === taskId);
    if (!task) return;
    _taskDonePending = taskId;
    const modal = document.getElementById("tbTaskDoneModal");
    const desc = document.getElementById("tbTaskDoneDescription");
    const fileInput = document.getElementById("tbTaskDonePhotos");
    if (!modal) {
      // Modal missing (old page) — fall back to legacy confirm flow.
      if (confirm(`Mark "${task.description}" done?`)) markTaskDone(taskId, []);
      return;
    }
    if (desc) desc.textContent = task.description;
    if (fileInput) fileInput.value = "";
    modal.hidden = false;
  }
  function closeTaskDoneModal() {
    const modal = document.getElementById("tbTaskDoneModal");
    if (modal) modal.hidden = true;
    _taskDonePending = null;
  }
  async function submitTaskDoneModal() {
    const taskId = _taskDonePending;
    if (!taskId) return;
    const fileInput = document.getElementById("tbTaskDonePhotos");
    const files = fileInput && fileInput.files ? Array.from(fileInput.files) : [];
    const photos = [];
    for (const f of files) {
      // Cap per-file size locally before send; server enforces hard cap.
      if (f.size > 25 * 1024 * 1024) {
        showToast(`${f.name} > 25 MB; skipped.`, { variant: "error" });
        continue;
      }
      try {
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(new Error("read failed"));
          r.readAsDataURL(f);
        });
        const base64 = String(dataUrl).split(",")[1] || "";
        photos.push({ data: base64, mediaType: f.type || "image/jpeg" });
      } catch (_) { /* skip */ }
    }
    closeTaskDoneModal();
    await markTaskDone(taskId, photos);
  }

  async function markTaskDone(taskId, photos = []) {
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/tasks-done`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, photos })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showToast(data.errors?.[0] || `Mark failed (${r.status})`, { variant: "error" });
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
      const photoCount = data.photosUploaded || 0;
      showToast(`Task done${photoCount ? ` · ${photoCount} photo${photoCount === 1 ? "" : "s"}` : ""}.`, { variant: "success" });
    } catch (err) { showToast(err.message || "Mark failed.", { variant: "error" }); }
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
  // Resolve a parts.json entry's human label. parts.json shape:
  //   { sku, partNumber, category, subcategory, size, description,
  //     priceCents, unit }
  // Earlier code looked for `label`/`name` which don't exist on these
  // entries — that's why the picker rendered only SKUs.
  function partLabel(part, sku) {
    if (!part) return sku;
    if (part.description) {
      const sizeBit = part.size ? ` (${part.size})` : "";
      return part.description + sizeBit;
    }
    return part.label || part.name || sku;
  }
  function partPriceDollars(part) {
    if (!part) return null;
    if (Number.isFinite(Number(part.priceCents))) return Number(part.priceCents) / 100;
    if (Number.isFinite(Number(part.retail_price))) return Number(part.retail_price);
    if (Number.isFinite(Number(part.retailPrice))) return Number(part.retailPrice);
    if (Number.isFinite(Number(part.price))) return Number(part.price);
    return null;
  }

  // Render the parts catalog as a collapsible category > subcategory tree
  // (matches the material-list builder pattern: `<details>` outer per
  // category, inner `<details>` per subcategory). Each row gets a -/+
  // qty stepper that stays keyboard-editable for cases like "I need 25
  // of these — type it" alongside the common "just 3 — tap +/+/+" path.
  //
  // showPrices: false for the tomorrow's-pack picker (Patrick's call —
  // tomorrow's plan is about WHAT not COST). True for consumed-today.
  // Search bypasses the tree and renders a flat result list.
  function renderMaterialsCatalog(search) {
    const partsRoot = state.parts || {};
    const partsMap = partsRoot.parts || partsRoot;
    const categories = Array.isArray(partsRoot.categories) ? partsRoot.categories : [];
    const showPrices = !state._nextDayMatsMode;
    const needle = String(search || "").trim().toLowerCase();

    if (needle) {
      // Search bypasses the tree and shows a flat capped list.
      const entries = Object.entries(partsMap).filter(([sku, part]) => {
        if (!part) return false;
        const hay = [
          sku, part.partNumber, part.description, part.category,
          part.subcategory, part.size
        ].map((v) => String(v || "").toLowerCase()).join(" ");
        return hay.includes(needle);
      }).slice(0, 60);
      els.materialsCatalog.innerHTML = entries.length
        ? `<div class="tech-cat-search-list">${entries.map(([sku, part]) => renderCatalogRow(sku, part, showPrices)).join("")}</div>`
        : `<p class="tech-cat-empty">No matching parts.</p>`;
    } else {
      // Tree view — group by category > subcategory, sorted within
      // each by part description for predictable order.
      const partsByCatSub = new Map();
      for (const [sku, part] of Object.entries(partsMap)) {
        if (!part) continue;
        const cat = part.category || "other";
        const sub = part.subcategory || "Other";
        if (!partsByCatSub.has(cat)) partsByCatSub.set(cat, new Map());
        const subMap = partsByCatSub.get(cat);
        if (!subMap.has(sub)) subMap.set(sub, []);
        subMap.get(sub).push([sku, part]);
      }
      // Sort items within each subcategory by size-rank then description.
      function sizeRank(s) {
        const m = String(s || "").match(/[\d.]+/);
        return m ? parseFloat(m[0]) : 999;
      }
      for (const subMap of partsByCatSub.values()) {
        for (const list of subMap.values()) {
          list.sort(([, a], [, b]) =>
            sizeRank(a.size) - sizeRank(b.size) ||
            String(a.description || "").localeCompare(String(b.description || ""))
          );
        }
      }
      // Render — use the canonical category order if defined.
      const orderedCats = categories.length
        ? categories.map((c) => c.key)
        : [...partsByCatSub.keys()];
      const catLabel = (key) => {
        const found = categories.find((c) => c.key === key);
        return found ? found.label : key.charAt(0).toUpperCase() + key.slice(1);
      };
      els.materialsCatalog.innerHTML = orderedCats.map((catKey) => {
        const subMap = partsByCatSub.get(catKey);
        if (!subMap || !subMap.size) return "";
        const totalItems = [...subMap.values()].reduce((sum, list) => sum + list.length, 0);
        const subBlocks = [...subMap.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([sub, list]) => `
            <details class="tech-cat-sub">
              <summary>
                ${escapeHtml(sub)}
                <span class="tech-cat-sub-count">${list.length}</span>
              </summary>
              <div class="tech-cat-sub-items">
                ${list.map(([sku, part]) => renderCatalogRow(sku, part, showPrices)).join("")}
              </div>
            </details>
          `).join("");
        return `
          <details class="tech-cat">
            <summary>
              ${escapeHtml(catLabel(catKey))}
              <span class="tech-cat-count">${totalItems}</span>
            </summary>
            <div class="tech-cat-body">${subBlocks}</div>
          </details>
        `;
      }).join("");
    }

    // Wire the steppers + the keyboard inputs once after render.
    wireCatalogRows();
    updateMaterialsSummary();
  }

  // Render a single catalog row — size badge + description + (optional)
  // price + qty stepper. Used by both the tree view and the search view.
  function renderCatalogRow(sku, part, showPrices) {
    const label = partLabel(part, sku);
    const price = partPriceDollars(part);
    const qty = state.materialsDraft[sku] || 0;
    const sizeBadge = part.size ? `<span class="tech-cat-size">${escapeHtml(part.size)}</span>` : "";
    const priceTag = showPrices && Number.isFinite(price) && price > 0
      ? `<div class="tech-cat-price">$${price.toFixed(2)}${part.unit ? "/" + escapeHtml(part.unit) : ""}</div>`
      : "";
    return `
      <div class="tech-cat-row" data-sku="${escapeHtml(sku)}">
        <div class="tech-cat-row-info">
          <div class="tech-cat-row-desc">${sizeBadge}<span>${escapeHtml(label)}</span></div>
          <div class="tech-cat-row-meta">
            <span class="tech-cat-sku">${escapeHtml(sku)}</span>${priceTag ? "<span class=\"tech-cat-sep\">·</span>" + priceTag : ""}
          </div>
        </div>
        <div class="tech-cat-stepper" role="group" aria-label="Quantity for ${escapeHtml(sku)}">
          <button type="button" class="tech-cat-stepper-btn" data-stepper="dec" data-sku="${escapeHtml(sku)}" aria-label="Decrease">−</button>
          <input type="number" inputmode="numeric" min="0" step="1" class="tech-cat-stepper-input" data-sku="${escapeHtml(sku)}" value="${qty}">
          <button type="button" class="tech-cat-stepper-btn" data-stepper="inc" data-sku="${escapeHtml(sku)}" aria-label="Increase">+</button>
        </div>
      </div>
    `;
  }

  function wireCatalogRows() {
    // Set qty from the input (keyboard-editable).
    els.materialsCatalog.querySelectorAll(".tech-cat-stepper-input").forEach((input) => {
      input.addEventListener("input", () => {
        const sku = input.dataset.sku;
        const q = parseFloat(input.value);
        if (Number.isFinite(q) && q > 0) state.materialsDraft[sku] = q;
        else delete state.materialsDraft[sku];
        updateMaterialsSummary();
      });
    });
    // -/+ buttons increment / decrement.
    els.materialsCatalog.querySelectorAll(".tech-cat-stepper-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sku = btn.dataset.sku;
        const dir = btn.dataset.stepper;
        const current = Number(state.materialsDraft[sku]) || 0;
        let next = dir === "inc" ? current + 1 : current - 1;
        if (next < 0) next = 0;
        // Update both state + the input field to keep them in sync.
        const input = els.materialsCatalog.querySelector(
          `.tech-cat-stepper-input[data-sku="${CSS.escape(sku)}"]`
        );
        if (input) input.value = next;
        if (next > 0) state.materialsDraft[sku] = next;
        else delete state.materialsDraft[sku];
        updateMaterialsSummary();
      });
    });
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
    // Dispatch to next-day path if the modal was opened in that mode.
    if (state._nextDayMatsMode) return confirmNextDayMats();
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
        showToast(data.errors?.[0] || "Add failed.", { variant: "error" });
        return;
      }
      state.wo = data.workOrder;
      closeMaterialsModal();
      renderMaterials();
      showToast(`Added ${items.length} material entr${items.length === 1 ? "y" : "ies"}.`, { variant: "success" });
    } catch (err) { showToast(err.message || "Add failed.", { variant: "error" }); }
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
  async function saveScope(sendImmediately = false) {
    const description = els.scopeDescription.value.trim();
    if (!description) { showToast("Description required.", { variant: "error" }); return; }
    if (!state.project) { showToast("This WO has no parent project.", { variant: "error" }); return; }

    // Upload any attached photos to the WO first (no taskId — these are
    // SCR-anchored, category 'issue' for backward-compat with renderer).
    const photoInput = document.getElementById("tbScopePhotos");
    const files = photoInput && photoInput.files ? Array.from(photoInput.files) : [];
    const uploadedPhotoNs = [];
    if (files.length) {
      const photos = [];
      for (const f of files) {
        if (f.size > 25 * 1024 * 1024) {
          showToast(`${f.name} > 25 MB; skipped.`, { variant: "error" });
          continue;
        }
        try {
          const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = () => rej(new Error("read failed"));
            r.readAsDataURL(f);
          });
          const base64 = String(dataUrl).split(",")[1] || "";
          photos.push({ data: base64, mediaType: f.type || "image/jpeg", category: "issue" });
        } catch (_) { /* skip */ }
      }
      if (photos.length) {
        try {
          const pr = await fetch(`/api/work-orders/${encodeURIComponent(WO_ID)}/photos`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ photos })
          });
          const pd = await pr.json().catch(() => ({}));
          if (pr.ok && pd.ok && Array.isArray(pd.added)) {
            uploadedPhotoNs.push(...pd.added.map((p) => String(p.n)));
          }
        } catch (err) { console.warn("[scope photos] upload failed:", err?.message); }
      }
    }

    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.project.id)}/scope-changes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description,
          capturedFromWoId: WO_ID,
          photoIds: uploadedPhotoNs,
          suggestedLineItems: state.scopeDraft.suggestedLineItems
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) { showToast(data.errors?.[0] || "Save failed.", { variant: "error" }); return; }
      const scrId = data.scopeChange.id;

      // If "Save & send" was the trigger, immediately flip to pending_customer_approval.
      if (sendImmediately) {
        try {
          const sr = await fetch(`/api/projects/${encodeURIComponent(state.project.id)}/scope-changes/${encodeURIComponent(scrId)}/send`, {
            method: "POST"
          });
          const sd = await sr.json().catch(() => ({}));
          if (!sr.ok || !sd.ok) {
            showToast(`Saved as draft (${scrId}); send failed: ${sd.errors?.[0] || "?"}`, { variant: "error", durationMs: 7000 });
          } else {
            closeScopeModal();
            showToast(`Sent to customer for approval (${scrId}).`, { variant: "success", durationMs: 6000 });
            return;
          }
        } catch (err) {
          showToast(`Saved as draft (${scrId}); send failed: ${err.message}`, { variant: "error", durationMs: 7000 });
        }
      }
      closeScopeModal();
      showToast(`Scope addition saved (${scrId}). Review on project page.`, { variant: "success", durationMs: 6000 });
    } catch (err) { showToast(err.message || "Save failed.", { variant: "error" }); }
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
    els.scopeSave.addEventListener("click", () => saveScope(false));
    document.getElementById("tbScopeSaveAndSend")?.addEventListener("click", () => saveScope(true));
    els.scopeModal.addEventListener("click", (e) => { if (e.target === els.scopeModal) closeScopeModal(); });

    // Task-done modal
    document.getElementById("tbTaskDoneCancel")?.addEventListener("click", closeTaskDoneModal);
    document.getElementById("tbTaskDoneConfirm")?.addEventListener("click", submitTaskDoneModal);
    const taskDoneModal = document.getElementById("tbTaskDoneModal");
    if (taskDoneModal) taskDoneModal.addEventListener("click", (e) => { if (e.target === taskDoneModal) closeTaskDoneModal(); });

    // Tomorrow's materials picker + promote
    document.getElementById("tbNextDayAddMatsBtn")?.addEventListener("click", openNextDayMatsModal);
    document.getElementById("tbPromoteNextDayMatsBtn")?.addEventListener("click", promoteNextDayMats);
  }

  boot();
})();
