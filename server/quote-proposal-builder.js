// Quote Proposal Builder front-end. Single-page editor for a
// project_proposal quote: top-bar identity + branch/billing, three-
// column body (section nav / editor / attachments + line items),
// bottom action bar.
//
// State management is deliberately simple: a single `state` object
// holds the working copy of the quote, dirty flag flips on edit, debounced
// auto-save PATCHes every 600 ms when dirty. No framework — direct DOM
// updates keep the page snappy.

(function () {
  "use strict";

  // ---- Route id parse ------------------------------------------------
  const pathMatch = location.pathname.match(/^\/admin\/quote\/([^/]+)\/proposal\/?$/);
  const QUOTE_ID = pathMatch ? decodeURIComponent(pathMatch[1]) : null;
  if (!QUOTE_ID) {
    document.getElementById("pbLoading").remove();
    document.getElementById("pbError").textContent = "No quote ID in URL.";
    document.getElementById("pbError").hidden = false;
    return;
  }

  // ---- DOM refs ------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    loading: $("pbLoading"),
    error: $("pbError"),
    app: $("pbApp"),
    title: $("pbTitle"),
    quoteId: $("pbQuoteId"),
    status: $("pbStatus"),
    version: $("pbVersion"),
    acceptBadge: $("pbAcceptBadge"),
    branch: $("pbBranch"),
    billingMode: $("pbBillingMode"),
    customerEmail: $("pbCustomerEmail"),
    labourRate: $("pbLabourRate"),
    validUntil: $("pbValidUntil"),
    quoteNumber: $("pbQuoteNumber"),
    scope: $("pbScope"),
    sectionList: $("pbSectionList"),
    addSection: $("pbAddSection"),
    sectionTitle: $("pbSectionTitle"),
    sectionKind: $("pbSectionKind"),
    sectionBody: $("pbSectionBody"),
    toolbar: $("pbToolbar"),
    showAttachments: $("pbShowAttachments"),
    showProjectMap: $("pbShowProjectMap"),
    sectionInclude: $("pbSectionInclude"),
    sectionIncludeWrap: $("pbSectionIncludeWrap"),
    sectionTip: $("pbSectionTip"),
    anchorList: $("pbAnchorList"),
    anchorPicker: $("pbAnchorPicker"),
    uploadInput: $("pbUploadInput"),
    attachList: $("pbAttachList"),
    linePicker: $("pbLinePicker"),
    customLine: $("pbCustomLine"),
    lineList: $("pbLineList"),
    subtotal: $("pbSubtotal"),
    hst: $("pbHst"),
    total: $("pbTotal"),
    saveState: $("pbSaveState"),
    previewLink: $("pbPreviewLink"),
    sendBtn: $("pbSendBtn"),
    reviseBtn: $("pbReviseBtn"),
    convertBtn: $("pbConvertBtn"),
    attest: $("pbAttest"),
    attestId: $("pbAttestId"),
    attestMeta: $("pbAttestMeta"),
    attestEmail: $("pbAttestEmail"),
    attestNote: $("pbAttestNote"),
    attestOpen: $("pbAttestOpen"),
    attestConfirm: $("pbAttestConfirm")
  };

  // ---- State ---------------------------------------------------------
  const state = {
    quote: null,
    projectRates: null,
    activeSectionId: null,
    saveTimer: null,
    isDirty: false,
    isSaving: false
  };

  function setSaveState(label, kind) {
    el.saveState.textContent = label;
    el.saveState.classList.toggle("is-dirty", kind === "dirty");
    el.saveState.classList.toggle("is-saving", kind === "saving");
  }

  function markDirty() {
    state.isDirty = true;
    setSaveState("Unsaved…", "dirty");
    scheduleSave();
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveDraft, 600);
  }

  async function saveDraft() {
    if (state.isSaving) return;
    state.isSaving = true;
    setSaveState("Saving…", "saving");
    try {
      const q = state.quote;
      const customRates = { ...q.customRates };
      const labourVal = parseFloat(el.labourRate.value);
      customRates.labour = Number.isFinite(labourVal) ? labourVal : null;
      const patch = {
        branch: el.branch.value || null,
        billingMode: el.billingMode.value || "fixed_price",
        customerEmail: el.customerEmail.value.trim(),
        validUntilDate: el.validUntil.value || null,
        scope: el.scope.value.trim(),
        customRates,
        proposalSections: q.proposalSections,
        lineItems: q.lineItems,
        pdfOptions: q.pdfOptions,
        quoteNumberDisplay: el.quoteNumber.value.trim()
      };
      const r = await fetch(`/api/quotes/${encodeURIComponent(q.id)}/proposal`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        if (r.status === 409) {
          setSaveState(`Locked: ${data.field || "field"}`, "dirty");
          showError(data.errors?.[0] || "Proposal is locked.");
        } else {
          setSaveState("Save failed", "dirty");
          showError(data.errors?.[0] || `Save failed (${r.status})`);
        }
        return;
      }
      state.quote = data.quote;
      state.isDirty = false;
      renderTotals();
      setSaveState("Saved", null);
    } catch (err) {
      setSaveState("Save failed", "dirty");
      showError(err.message || "Save failed.");
    } finally {
      state.isSaving = false;
    }
  }

  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = false;
    setTimeout(() => { el.error.hidden = true; }, 6000);
  }

  // ---- Render --------------------------------------------------------
  function render() {
    const q = state.quote;
    el.title.textContent = `Proposal ${q.id}`;
    el.quoteId.textContent = q.id;
    el.status.textContent = q.status;
    el.status.className = `pb-status invoices-status invoices-status--${q.status}`;
    if ((q.version || 1) > 1) {
      el.version.textContent = `v${q.version}`;
      el.version.hidden = false;
    }
    if (q.acceptanceMethod && q.acceptanceMethod !== "pending") {
      el.acceptBadge.textContent = q.acceptanceMethod === "portal_esign" ? "E-signed" : "PDF returned";
      el.acceptBadge.dataset.method = q.acceptanceMethod;
      el.acceptBadge.hidden = false;
    } else if (q.status === "pending_admin_attestation") {
      el.acceptBadge.textContent = "Awaiting your attest";
      el.acceptBadge.dataset.method = "pending_admin_attestation";
      el.acceptBadge.hidden = false;
    }

    el.branch.value = q.branch || "";
    el.billingMode.value = q.billingMode || "fixed_price";
    el.customerEmail.value = q.customerEmail || "";
    el.labourRate.value = q.customRates?.labour != null ? q.customRates.labour : "";
    if (q.validUntil) {
      el.validUntil.value = String(q.validUntil).slice(0, 10);
    }
    el.quoteNumber.value = q.quoteNumberDisplay || "";
    el.scope.value = q.scope || "";

    // PDF display options (Brief D). Missing → itemized/true/true.
    const opts = q.pdfOptions || {};
    document.querySelectorAll('input[name="pbLineItems"]').forEach((r) => {
      r.checked = r.value === (opts.lineItems || "itemized");
    });
    if (el.showAttachments) el.showAttachments.checked = opts.showAttachments !== false;
    if (el.showProjectMap) el.showProjectMap.checked = opts.showProjectMap !== false;

    // Lock UI when not in draft.
    const locked = q.status !== "draft";
    [el.branch, el.billingMode, el.customerEmail, el.labourRate, el.validUntil,
     el.quoteNumber, el.scope, el.sectionTitle, el.sectionBody, el.uploadInput,
     el.linePicker, el.customLine, el.anchorPicker, el.addSection,
     el.showAttachments, el.showProjectMap]
      .forEach((node) => { if (node) node.disabled = locked; });
    if (el.toolbar) el.toolbar.querySelectorAll(".pb-tb-btn").forEach((b) => { b.disabled = locked; });
    document.querySelectorAll('input[name="pbLineItems"]').forEach((r) => { r.disabled = locked; });

    el.sendBtn.hidden = q.status !== "draft";
    el.reviseBtn.hidden = !(q.status === "sent" || q.status === "expired");
    el.convertBtn.hidden = q.status !== "accepted";
    el.attest.hidden = q.status !== "pending_admin_attestation";

    if (q.status === "pending_admin_attestation" && q.acceptanceEvidence) {
      el.attestId.textContent = q.id;
      el.attestMeta.textContent = `Received ${new Date(q.acceptanceEvidence.receivedAt || Date.now()).toLocaleString("en-CA")}` +
        (q.acceptanceEvidence.senderEmail ? ` · from ${q.acceptanceEvidence.senderEmail}` : "");
      el.attestEmail.value = q.acceptanceEvidence.senderEmail || "";
      const attId = q.acceptanceEvidence.uploadedPdfAttachmentId;
      if (attId) {
        el.attestOpen.href = `/api/quotes/${encodeURIComponent(q.id)}/attachments/${encodeURIComponent(attId)}`;
      }
    }

    renderSectionList();
    renderActiveSection();
    renderAttachments();
    renderLineItems();
    renderTotals();
    refreshPreviewLink();
  }

  // Structural sections (pricing table + acceptance block) always render
  // last in the PDF and cannot be deleted or reordered (Brief C1). They're
  // pinned to the bottom of the nav with a "Required" tag instead of controls.
  const STRUCTURAL_KINDS = ["line_items", "acceptance_block"];

  function renderSectionList() {
    const all = [...(state.quote.proposalSections || [])].sort(
      (a, b) => (a.order || 0) - (b.order || 0)
    );
    const narrative = all.filter((s) => !STRUCTURAL_KINDS.includes(s.kind));
    const structural = all.filter((s) => STRUCTURAL_KINDS.includes(s.kind));
    const locked = state.quote.status !== "draft";

    const liFor = (s, isStructural, idxInNarrative, narrativeCount) => {
      const isActive = s.id === state.activeSectionId;
      const hasContent = (s.body && s.body.trim()) || (s.attachmentIds && s.attachmentIds.length);
      let controls = "";
      if (isStructural) {
        controls = `<span class="pb-sec-req" title="Required — auto-rendered in the PDF">Required</span>`;
      } else if (!locked) {
        const upDis = idxInNarrative === 0 ? "disabled" : "";
        const downDis = idxInNarrative === narrativeCount - 1 ? "disabled" : "";
        controls =
          `<span class="pb-sec-controls">` +
          `<button type="button" class="pb-sec-btn" data-move-up="${s.id}" ${upDis} aria-label="Move up" title="Move up">↑</button>` +
          `<button type="button" class="pb-sec-btn" data-move-down="${s.id}" ${downDis} aria-label="Move down" title="Move down">↓</button>` +
          `<button type="button" class="pb-sec-btn pb-sec-del" data-del="${s.id}" aria-label="Delete section" title="Delete section">✕</button>` +
          `</span>`;
      }
      const excluded = !isStructural && s.include === false;
      const nameMarker = excluded ? ` <span class="pb-sec-hidden" title="Hidden from the customer PDF (Brief D)">hidden</span>` : "";
      return `<li data-id="${s.id}" class="${isActive ? "is-active" : ""} ${hasContent ? "has-content" : ""} ${isStructural ? "is-structural" : ""} ${excluded ? "is-excluded" : ""}">` +
        `<span class="pb-sec-name">${escapeHtml(s.title || s.kind)}${nameMarker}</span>${controls}</li>`;
    };

    el.sectionList.innerHTML =
      narrative.map((s, i) => liFor(s, false, i, narrative.length)).join("") +
      structural.map((s) => liFor(s, true)).join("");

    // Select on name click (control buttons stop propagation below).
    el.sectionList.querySelectorAll(".pb-sec-name").forEach((name) => {
      name.addEventListener("click", () => {
        state.activeSectionId = name.closest("li").dataset.id;
        renderActiveSection();
        renderSectionList();
      });
    });
    if (!locked) {
      el.sectionList.querySelectorAll("[data-move-up]").forEach((b) =>
        b.addEventListener("click", (e) => { e.stopPropagation(); moveSection(b.dataset.moveUp, -1); }));
      el.sectionList.querySelectorAll("[data-move-down]").forEach((b) =>
        b.addEventListener("click", (e) => { e.stopPropagation(); moveSection(b.dataset.moveDown, 1); }));
      el.sectionList.querySelectorAll("[data-del]").forEach((b) =>
        b.addEventListener("click", (e) => { e.stopPropagation(); removeSection(b.dataset.del); }));
    }
  }

  // Reorder a narrative section by swapping its `order` with the adjacent
  // narrative section (dir −1 up / +1 down). Structural sections are pinned
  // last by the renderer, so they're excluded from the swap set. Order in
  // the array's sorted `order` sequence is order in the PDF.
  function moveSection(id, dir) {
    const narrative = [...(state.quote.proposalSections || [])]
      .filter((s) => !STRUCTURAL_KINDS.includes(s.kind))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const i = narrative.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= narrative.length) return; // clamp — no-op at ends
    const a = narrative[i], b = narrative[j];
    const ao = Number(a.order) || 0, bo = Number(b.order) || 0;
    a.order = bo; b.order = ao;
    renderSectionList();
    markDirty();
  }

  function removeSection(id) {
    const sec = (state.quote.proposalSections || []).find((s) => s.id === id);
    if (!sec || STRUCTURAL_KINDS.includes(sec.kind)) return; // structural: guarded server-side too
    if (!confirm(`Delete section "${sec.title || sec.kind}"? This can't be undone.`)) return;
    state.quote.proposalSections = (state.quote.proposalSections || []).filter((s) => s.id !== id);
    if (state.activeSectionId === id) {
      const next = (state.quote.proposalSections || [])[0];
      state.activeSectionId = next ? next.id : null;
    }
    renderSectionList();
    renderActiveSection();
    markDirty();
  }

  // Add a new custom section. The section is appended with no id and saved
  // immediately so the SERVER mints the sec_ id (single source — Brief C1
  // Q4); we then read it back from the save response and focus its title.
  async function addSection() {
    if (!state.quote || state.quote.status !== "draft") return;
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    while (state.isSaving) await new Promise((r) => setTimeout(r, 50));
    const beforeIds = new Set((state.quote.proposalSections || []).map((s) => s.id));
    const maxOrder = (state.quote.proposalSections || [])
      .reduce((m, s) => Math.max(m, Number(s.order) || 0), -1);
    state.quote.proposalSections = [
      ...(state.quote.proposalSections || []),
      { kind: "custom", title: "New section", body: "", order: maxOrder + 1, attachmentIds: [] }
    ];
    await saveDraft();
    const created = (state.quote.proposalSections || []).find((s) => s.id && !beforeIds.has(s.id));
    if (created) state.activeSectionId = created.id;
    render();
    if (state.quote.status === "draft") { el.sectionTitle.focus(); el.sectionTitle.select(); }
  }
  el.addSection.addEventListener("click", addSection);

  function renderActiveSection() {
    const sec = (state.quote.proposalSections || []).find((s) => s.id === state.activeSectionId);
    if (!sec) {
      el.sectionTitle.value = "";
      el.sectionBody.value = "";
      el.sectionKind.textContent = "—";
      el.anchorList.innerHTML = "";
      if (el.sectionIncludeWrap) el.sectionIncludeWrap.hidden = true;
      return;
    }
    el.sectionTitle.value = sec.title || "";
    el.sectionBody.value = sec.body || "";
    el.sectionKind.textContent = sec.kind || "";
    el.sectionTip.textContent = SECTION_TIPS[sec.kind] || "";

    // Include-in-PDF toggle (Brief D). Structural sections are always
    // included and cannot be toggled off.
    const secStructural = STRUCTURAL_KINDS.includes(sec.kind);
    if (el.sectionIncludeWrap) {
      el.sectionIncludeWrap.hidden = false;
      el.sectionIncludeWrap.classList.toggle("is-structural", secStructural);
      el.sectionIncludeWrap.title = secStructural
        ? "Required section — always included in the PDF"
        : "Untick to keep this section on the record but hide it from the customer PDF";
    }
    if (el.sectionInclude) {
      el.sectionInclude.checked = secStructural ? true : sec.include !== false;
      el.sectionInclude.disabled = secStructural || (state.quote.status !== "draft");
    }

    // Anchor list.
    el.anchorList.innerHTML = (sec.attachmentIds || []).map((id) => {
      const att = (state.quote.attachments || []).find((a) => a.id === id);
      if (!att) return "";
      return `<span class="pb-anchor-chip">${escapeHtml(att.caption || att.filename || id)}<button type="button" data-detach="${id}" aria-label="Detach">×</button></span>`;
    }).join("");
    el.anchorList.querySelectorAll("[data-detach]").forEach((btn) => {
      btn.addEventListener("click", () => {
        sec.attachmentIds = (sec.attachmentIds || []).filter((id) => id !== btn.dataset.detach);
        renderActiveSection();
        markDirty();
      });
    });

    // Anchor picker — only show attachments NOT yet anchored to this section.
    const used = new Set(sec.attachmentIds || []);
    const available = (state.quote.attachments || []).filter((a) => !used.has(a.id) && a.kind !== "signed_pdf_return");
    el.anchorPicker.innerHTML = `<option value="">+ Add attachment to this section…</option>` +
      available.map((a) => `<option value="${a.id}">${escapeHtml(a.caption || a.filename || a.id)}</option>`).join("");
  }

  function renderAttachments() {
    const atts = (state.quote.attachments || []).filter((a) => a.kind !== "signed_pdf_return");
    el.attachList.innerHTML = atts.map((a) => {
      const isImage = a.mimeType === "image/png" || a.mimeType === "image/jpeg";
      const thumb = isImage
        ? `<img class="pb-attach-thumb" src="/api/quotes/${encodeURIComponent(state.quote.id)}/attachments/${encodeURIComponent(a.id)}" alt="">`
        : `<div class="pb-attach-thumb pb-attach-thumb--pdf">PDF</div>`;
      return `
        <li class="pb-attach-item" data-id="${a.id}">
          ${thumb}
          <div class="pb-attach-body">
            <div class="pb-attach-name">${escapeHtml(a.filename || a.id)}</div>
            <div class="pb-attach-kind">${escapeHtml(a.kind)}</div>
            <input type="text" class="pb-attach-caption" data-att-caption="${a.id}" placeholder="Caption" value="${escapeAttr(a.caption || "")}">
            <div class="pb-attach-actions">
              <button type="button" data-att-remove="${a.id}">Remove</button>
            </div>
          </div>
        </li>
      `;
    }).join("");
    // Caption inputs do not persist via PATCH yet (attachments are
    // outside the scope-protected fields for a draft only) — keep
    // them visual for now; the v1 ship doesn't require caption edits.
    el.attachList.querySelectorAll("[data-att-remove]").forEach((btn) => {
      btn.addEventListener("click", () => removeAttachment(btn.dataset.attRemove));
    });
  }

  function renderLineItems() {
    const lines = state.quote.lineItems || [];
    const emptyEl = document.getElementById("pbLinesEmpty");
    if (emptyEl) emptyEl.hidden = lines.length > 0;
    el.lineList.innerHTML = lines.map((li, idx) => {
      const sourceLabel = li.source === "pricing" ? "Pricing.json"
        : li.source === "project_rates" ? "Project rates"
        : li.source === "labour" ? "Labour"
        : "Custom";
      return `
        <tr class="pb-line-row" data-idx="${idx}">
          <td class="pb-col-desc" data-label="Description"><input type="text" data-li-label="${idx}" value="${escapeAttr(li.label)}" placeholder="Description"></td>
          <td class="pb-col-source" data-label="Source"><span class="pb-line-source-badge" data-source="${escapeAttr(li.source || "custom")}">${escapeHtml(sourceLabel)}</span></td>
          <td class="pb-col-qty" data-label="Qty"><input type="number" data-li-qty="${idx}" value="${li.qty}" min="0" step="0.01"></td>
          <td class="pb-col-unit" data-label="Unit"><input type="text" data-li-unit="${idx}" value="${escapeAttr(li.unit || "")}" placeholder="each / ft / hr"></td>
          <td class="pb-col-price" data-label="Unit price"><input type="number" data-li-price="${idx}" value="${li.price}" min="0" step="0.01"></td>
          <td class="pb-col-total" data-label="Line total">$${(li.lineTotal || 0).toFixed(2)}</td>
          <td class="pb-col-remove"><button type="button" class="pb-line-remove" data-li-remove="${idx}" aria-label="Remove">×</button></td>
        </tr>
      `;
    }).join("");
    el.lineList.querySelectorAll("[data-li-label]").forEach((input) => {
      input.addEventListener("input", () => {
        const i = Number(input.dataset.liLabel);
        state.quote.lineItems[i].label = input.value;
        markDirty();
      });
    });
    el.lineList.querySelectorAll("[data-li-unit]").forEach((input) => {
      input.addEventListener("input", () => {
        const i = Number(input.dataset.liUnit);
        state.quote.lineItems[i].unit = input.value;
        markDirty();
      });
    });
    el.lineList.querySelectorAll("[data-li-qty]").forEach((input) => {
      input.addEventListener("input", () => {
        const i = Number(input.dataset.liQty);
        const v = parseFloat(input.value);
        state.quote.lineItems[i].qty = Number.isFinite(v) ? v : 0;
        recomputeLineTotal(i);
        // Update this row's total + the footer IN PLACE — re-rendering the
        // whole table here would destroy the input mid-keystroke (focus loss).
        updateLineTotalCell(input, i);
        renderTotals();
        markDirty();
      });
    });
    el.lineList.querySelectorAll("[data-li-price]").forEach((input) => {
      input.addEventListener("input", () => {
        const i = Number(input.dataset.liPrice);
        const v = parseFloat(input.value);
        state.quote.lineItems[i].price = Number.isFinite(v) ? v : 0;
        recomputeLineTotal(i);
        updateLineTotalCell(input, i);   // in place — keep focus in the field
        renderTotals();
        markDirty();
      });
    });
    el.lineList.querySelectorAll("[data-li-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.liRemove);
        state.quote.lineItems.splice(i, 1);
        renderLineItems();
        renderTotals();
        markDirty();
      });
    });
  }

  function recomputeLineTotal(i) {
    const li = state.quote.lineItems[i];
    li.lineTotal = Math.round((Number(li.qty) || 0) * (Number(li.price) || 0) * 100) / 100;
  }

  // Update a single row's line-total cell without rebuilding the table, so
  // the field the user is typing in keeps focus.
  function updateLineTotalCell(input, i) {
    const row = input.closest("tr");
    const cell = row && row.querySelector(".pb-col-total");
    if (cell) cell.textContent = "$" + (state.quote.lineItems[i].lineTotal || 0).toFixed(2);
  }

  function renderTotals() {
    let subtotal = 0;
    for (const li of (state.quote.lineItems || [])) subtotal += Number(li.lineTotal) || 0;
    subtotal = Math.round(subtotal * 100) / 100;
    const hst = Math.round(subtotal * 0.13 * 100) / 100;
    const total = Math.round((subtotal + hst) * 100) / 100;
    el.subtotal.textContent = "$" + subtotal.toFixed(2);
    el.hst.textContent = "$" + hst.toFixed(2);
    el.total.textContent = "$" + total.toFixed(2);
  }

  function refreshPreviewLink() {
    el.previewLink.href = `/api/admin/quote-folder/${encodeURIComponent(state.quote.id)}/pdf`;
  }

  // ---- Catalog (project_rates) --------------------------------------
  async function loadProjectRates() {
    try {
      const r = await fetch("/api/admin/project-rates", { cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      if (data.ok && data.projectRates) state.projectRates = data.projectRates;
    } catch (_) { /* offline-fine */ }
    renderLinePicker();
  }

  function renderLinePicker() {
    const items = state.projectRates?.items || {};
    const opts = Object.entries(items).map(([key, item]) =>
      `<option value="${key}">${escapeHtml(item.label)} — $${Number(item.price).toFixed(2)}/${item.unit || "unit"}</option>`
    );
    el.linePicker.innerHTML = `<option value="">+ Add from project rates…</option>` + opts.join("");
  }

  // ---- Section tips --------------------------------------------------
  const SECTION_TIPS = {
    cover_summary: "Two or three sentences. What this proposal covers, in plain English, for someone scanning page one.",
    quotation_summary: "Bullet-style summary of the totals and headline scope items — used in commercial GC packets.",
    proposed_scope: "Detailed scope of work. The contractual narrative. Be specific about deliverables and exclusions.",
    infrastructure_list: "Bill of materials at the high level — what infrastructure (mainline, valves, controller) is being installed.",
    budget_notice: "Assumptions, exclusions, and contingencies. Anything that could change the price gets called out here.",
    technical_reference: "Manufacturer cut sheets, model numbers, design references. Specs live here.",
    project_map: "Anchor your Google Earth screenshot or CAD drawing in this section so it embeds inline.",
    line_items: "Auto-rendered from the Line Items panel on the right. Don't repeat the table here.",
    acceptance_block: "Auto-rendered. Customer signs online OR prints, signs, and emails the PDF back."
  };

  // ---- Attachment upload --------------------------------------------
  el.uploadInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      showError("File too large — 25 MB cap.");
      e.target.value = "";
      return;
    }
    const allowed = ["image/png", "image/jpeg", "application/pdf"];
    if (!allowed.includes(file.type)) {
      showError("Only PNG, JPEG, or PDF.");
      e.target.value = "";
      return;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error("Could not read file."));
        fr.readAsDataURL(file);
      });
      const base64 = String(dataUrl).split(",")[1] || "";
      const r = await fetch(`/api/quotes/${encodeURIComponent(state.quote.id)}/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type,
          data: base64,
          kind: file.type === "application/pdf" ? "technical_diagram" : "site_map",
          caption: ""
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showError(data.errors?.[0] || `Upload failed (${r.status})`);
        return;
      }
      state.quote.attachments = [...(state.quote.attachments || []), data.attachment];
      renderAttachments();
      renderActiveSection();
    } catch (err) {
      showError(err.message || "Upload failed.");
    } finally {
      e.target.value = "";
    }
  });

  async function removeAttachment(attId) {
    if (!confirm("Remove this attachment? The file will be deleted.")) return;
    try {
      const r = await fetch(`/api/quotes/${encodeURIComponent(state.quote.id)}/attachments/${encodeURIComponent(attId)}`, {
        method: "DELETE"
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showError(data.errors?.[0] || "Remove failed.");
        return;
      }
      state.quote.attachments = (state.quote.attachments || []).filter((a) => a.id !== attId);
      for (const s of (state.quote.proposalSections || [])) {
        s.attachmentIds = (s.attachmentIds || []).filter((id) => id !== attId);
      }
      renderAttachments();
      renderActiveSection();
    } catch (err) {
      showError(err.message || "Remove failed.");
    }
  }

  // ---- Anchor picker -------------------------------------------------
  el.anchorPicker.addEventListener("change", () => {
    const attId = el.anchorPicker.value;
    if (!attId) return;
    const sec = (state.quote.proposalSections || []).find((s) => s.id === state.activeSectionId);
    if (!sec) return;
    sec.attachmentIds = [...(sec.attachmentIds || []), attId];
    el.anchorPicker.value = "";
    renderActiveSection();
    markDirty();
  });

  // ---- Line item add ------------------------------------------------
  el.linePicker.addEventListener("change", () => {
    const key = el.linePicker.value;
    if (!key) return;
    const item = state.projectRates?.items?.[key];
    if (!item) return;
    const li = {
      id: "li_" + Math.random().toString(36).slice(2, 10),
      source: "project_rates",
      sourceKey: key,
      label: item.label,
      description: "",
      unit: item.unit || "",
      qty: 1,
      price: Number(item.price) || 0,
      priceAtCreation: Number(item.price) || 0,
      lineTotal: Number(item.price) || 0
    };
    state.quote.lineItems = [...(state.quote.lineItems || []), li];
    el.linePicker.value = "";
    renderLineItems();
    renderTotals();
    markDirty();
  });

  el.customLine.addEventListener("click", () => {
    const label = prompt("Description for the custom line item:");
    if (!label) return;
    const price = parseFloat(prompt("Unit price ($):"));
    if (!Number.isFinite(price)) return;
    const li = {
      id: "li_" + Math.random().toString(36).slice(2, 10),
      source: "custom",
      sourceKey: null,
      label,
      description: "",
      unit: "",
      qty: 1,
      price,
      priceAtCreation: price,
      lineTotal: price
    };
    state.quote.lineItems = [...(state.quote.lineItems || []), li];
    renderLineItems();
    renderTotals();
    markDirty();
  });

  // ---- Section editor inputs ---------------------------------------
  el.sectionTitle.addEventListener("input", () => {
    const sec = (state.quote.proposalSections || []).find((s) => s.id === state.activeSectionId);
    if (!sec) return;
    sec.title = el.sectionTitle.value;
    renderSectionList();
    markDirty();
  });
  el.sectionBody.addEventListener("input", () => {
    const sec = (state.quote.proposalSections || []).find((s) => s.id === state.activeSectionId);
    if (!sec) return;
    sec.body = el.sectionBody.value;
    renderSectionList();
    markDirty();
  });

  // ---- Formatting toolbar (Brief C2) --------------------------------
  // Writes the closed markup convention into the textarea. Body stays a
  // <textarea> — no contenteditable. The renderer's parseSectionBody reads
  // the markers back. Buttons preventDefault on mousedown so tapping one
  // never steals the selection from the textarea before the handler runs.
  const INLINE_MARKER = { bold: "**", underline: "__", italic: "*" };

  function applyInlineMarker(ta, marker) {
    const s = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    const sel = s.slice(a, b);
    const m = marker.length;
    if (sel.length >= 2 * m && sel.startsWith(marker) && sel.endsWith(marker)) {
      // selection includes the markers → unwrap
      const inner = sel.slice(m, sel.length - m);
      ta.setRangeText(inner, a, b, "select");
    } else if (s.slice(Math.max(0, a - m), a) === marker && s.slice(b, b + m) === marker) {
      // markers sit just outside the selection → remove them
      ta.setRangeText(sel, a - m, b + m, "select");
    } else {
      ta.setRangeText(marker + sel + marker, a, b, "end");
      ta.selectionStart = a + m;
      ta.selectionEnd = b + m; // keep the inner text selected
    }
  }

  function lineRange(s, a, b) {
    const start = s.lastIndexOf("\n", a - 1) + 1;
    let end = s.indexOf("\n", b);
    if (end === -1) end = s.length;
    return [start, end];
  }

  function toggleLinePrefix(ta, kind) {
    const s = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    const [ls, le] = lineRange(s, a, b);
    const lines = s.slice(ls, le).split("\n");
    const rx = kind === "bullet" ? /^(\s*)-\s+/ : /^(\s*)\d+\.\s+/;
    const nonEmpty = lines.filter((ln) => ln.trim() !== "");
    const allPrefixed = nonEmpty.length > 0 && nonEmpty.every((ln) => rx.test(ln));
    const out = lines.map((ln) => {
      if (ln.trim() === "") return ln;
      const im = ln.match(/^(\s*)(.*)$/);
      const indent = im[1];
      const bare = im[2].replace(/^-\s+/, "").replace(/^\d+\.\s+/, "");
      if (allPrefixed) return indent + bare;
      return indent + (kind === "bullet" ? "- " : "1. ") + bare;
    });
    ta.setRangeText(out.join("\n"), ls, le, "select");
  }

  function indentLines(ta, dir) {
    const s = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    const [ls, le] = lineRange(s, a, b);
    const lines = s.slice(ls, le).split("\n");
    const out = lines.map((ln) => {
      if (dir > 0) return /^\s{2,}/.test(ln) ? ln : "  " + ln; // clamp at level 1
      return ln.replace(/^ {1,2}/, "");
    });
    ta.setRangeText(out.join("\n"), ls, le, "select");
  }

  function runToolbar(fmt) {
    const ta = el.sectionBody;
    if (!ta || ta.disabled) return;
    if (INLINE_MARKER[fmt]) applyInlineMarker(ta, INLINE_MARKER[fmt]);
    else if (fmt === "bullet" || fmt === "numbered") toggleLinePrefix(ta, fmt);
    else if (fmt === "indent") indentLines(ta, 1);
    else if (fmt === "outdent") indentLines(ta, -1);
    const sec = (state.quote.proposalSections || []).find((x) => x.id === state.activeSectionId);
    if (sec) { sec.body = ta.value; renderSectionList(); markDirty(); }
    ta.focus();
  }

  if (el.toolbar) {
    // Don't let the button take focus off the textarea (would drop the
    // selection before the click handler runs). Brief C2 §3.5.
    el.toolbar.addEventListener("mousedown", (e) => { if (e.target.closest(".pb-tb-btn")) e.preventDefault(); });
    el.toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest(".pb-tb-btn");
      if (btn) runToolbar(btn.dataset.fmt);
    });
  }

  // ---- PDF display options (Brief D) --------------------------------
  // Presentation only — these never touch line items, totals math, QB, or
  // the invoice. The server validates the enum + guards structural
  // sections; the client just mirrors state into pdfOptions / section.include.
  function ensurePdfOptions() {
    if (!state.quote.pdfOptions || typeof state.quote.pdfOptions !== "object") {
      state.quote.pdfOptions = { lineItems: "itemized", showAttachments: true, showProjectMap: true };
    }
  }
  document.querySelectorAll('input[name="pbLineItems"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      ensurePdfOptions();
      state.quote.pdfOptions.lineItems = r.value;
      markDirty();
    });
  });
  if (el.showAttachments) el.showAttachments.addEventListener("change", () => {
    ensurePdfOptions();
    state.quote.pdfOptions.showAttachments = el.showAttachments.checked;
    markDirty();
  });
  if (el.showProjectMap) el.showProjectMap.addEventListener("change", () => {
    ensurePdfOptions();
    state.quote.pdfOptions.showProjectMap = el.showProjectMap.checked;
    markDirty();
  });
  if (el.sectionInclude) el.sectionInclude.addEventListener("change", () => {
    const sec = (state.quote.proposalSections || []).find((s) => s.id === state.activeSectionId);
    if (!sec || STRUCTURAL_KINDS.includes(sec.kind)) return; // structural: never toggleable
    sec.include = el.sectionInclude.checked;
    renderSectionList();
    markDirty();
  });

  // ---- Top-bar inputs ----------------------------------------------
  [el.branch, el.billingMode].forEach((node) => {
    node.addEventListener("change", markDirty);
  });
  [el.customerEmail, el.labourRate, el.validUntil, el.quoteNumber, el.scope].forEach((node) => {
    node.addEventListener("input", markDirty);
  });

  // ---- Send / Revise / Convert / Attest ----------------------------
  el.sendBtn.addEventListener("click", async () => {
    if (state.isDirty) await saveDraft();
    const email = state.quote.customerEmail;
    if (!email) {
      showError("Customer email is required before sending.");
      return;
    }
    if (!confirm(`Send proposal ${state.quote.id} to ${email}? This locks the proposal.`)) return;
    try {
      const r = await fetch(`/api/quotes/${encodeURIComponent(state.quote.id)}/send-proposal-for-approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, sendEmail: true, sendSms: false })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showError(data.errors?.[0] || "Send failed.");
        return;
      }
      state.quote = data.quote;
      alert(`Sent. ${data.emailSent ? "Email delivered." : "Email NOT sent: " + (data.emailError || "?")}` +
        `\n\nApproval URL:\n${data.approvalUrl}`);
      render();
    } catch (err) {
      showError(err.message || "Send failed.");
    }
  });

  el.reviseBtn.addEventListener("click", async () => {
    if (!confirm(`Create a new revision of ${state.quote.id}? The current quote will be marked superseded.`)) return;
    try {
      const r = await fetch(`/api/quotes/${encodeURIComponent(state.quote.id)}/revise`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showError(data.errors?.[0] || "Revise failed.");
        return;
      }
      location.href = `/admin/quote/${encodeURIComponent(data.quote.id)}/proposal`;
    } catch (err) {
      showError(err.message || "Revise failed.");
    }
  });

  el.convertBtn.addEventListener("click", async () => {
    if (!confirm(`Convert ${state.quote.id} to a Project? Tasks will be seeded from the line items.`)) return;
    try {
      const r = await fetch(`/api/quotes/${encodeURIComponent(state.quote.id)}/convert-to-project`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showError(data.errors?.[0] || "Convert failed.");
        return;
      }
      location.href = `/admin/project/${encodeURIComponent(data.project.id)}`;
    } catch (err) {
      showError(err.message || "Convert failed.");
    }
  });

  el.attestConfirm.addEventListener("click", async () => {
    if (!confirm(`Confirm you've reviewed the signed PDF and ${state.quote.id} is correctly accepted?`)) return;
    try {
      const r = await fetch(`/api/admin/quote-folder/${encodeURIComponent(state.quote.id)}/confirm-pdf-acceptance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adminNote: el.attestNote.value || "",
          senderEmailOverride: el.attestEmail.value || ""
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showError(data.errors?.[0] || "Attest failed.");
        return;
      }
      state.quote = data.quote;
      render();
    } catch (err) {
      showError(err.message || "Attest failed.");
    }
  });

  // ---- Bootstrap -----------------------------------------------------
  async function bootstrap() {
    try {
      const r = await fetch(`/api/admin/quote-folder?id=${encodeURIComponent(QUOTE_ID)}`, { cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      let q = null;
      if (data.ok && Array.isArray(data.quotes)) {
        q = data.quotes.find((x) => x.id === QUOTE_ID);
      }
      // Fallback to the direct admin lookup endpoint via the catch-all
      // list endpoint with status filter — single-record path.
      if (!q) {
        const r2 = await fetch(`/api/admin/quote-folder`, { cache: "no-store" });
        const d2 = await r2.json().catch(() => ({}));
        if (d2.ok) q = (d2.quotes || []).find((x) => x.id === QUOTE_ID);
      }
      if (!q) {
        el.loading.remove();
        el.error.textContent = `Proposal ${QUOTE_ID} not found.`;
        el.error.hidden = false;
        return;
      }
      if (q.type !== "project_proposal") {
        el.loading.remove();
        el.error.textContent = `${QUOTE_ID} is a ${q.type}, not a project proposal. This editor is for project proposals only.`;
        el.error.hidden = false;
        return;
      }
      state.quote = q;
      state.activeSectionId = q.proposalSections?.[0]?.id || null;

      el.loading.hidden = true;
      el.app.hidden = false;
      render();
      loadProjectRates();
    } catch (err) {
      el.loading.remove();
      el.error.textContent = err.message || "Could not load proposal.";
      el.error.hidden = false;
    }
  }

  // ---- Utils ---------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function escapeAttr(s) { return escapeHtml(s); }

  bootstrap();
})();
