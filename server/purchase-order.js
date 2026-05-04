// Purchase Order detail — Phase 3.
// Status-aware: draft is fully editable + has Send/Delete; sent has
// Receive/Cancel/PDF; received and cancelled are read-only with the PDF
// link. Auto-save on field edits while draft (1.2s debounce).

(function () {
  const els = {
    loading: document.getElementById("poLoading"),
    error: document.getElementById("poError"),
    page: document.getElementById("poPage"),
    id: document.getElementById("poId"),
    status: document.getElementById("poStatus"),
    sourceList: document.getElementById("poSourceList"),
    pdfLink: document.getElementById("poPdfLink"),

    supplierName: document.getElementById("poSupplierName"),
    supplierContactName: document.getElementById("poSupplierContactName"),
    supplierEmail: document.getElementById("poSupplierEmail"),
    supplierPhone: document.getElementById("poSupplierPhone"),
    supplierAddress: document.getElementById("poSupplierAddress"),
    notes: document.getElementById("poNotes"),
    internalNotes: document.getElementById("poInternalNotes"),

    lineCount: document.getElementById("poLineCount"),
    linesEmpty: document.getElementById("poLinesEmpty"),
    lines: document.getElementById("poLines"),
    subtotal: document.getElementById("poSubtotal"),

    history: document.getElementById("poHistory"),

    sendBtn: document.getElementById("poSendButton"),
    resendBtn: document.getElementById("poResendButton"),
    receiveBtn: document.getElementById("poReceiveButton"),
    reorderBtn: document.getElementById("poReorderButton"),
    cancelBtn: document.getElementById("poCancelButton"),
    deleteBtn: document.getElementById("poDeleteButton"),

    savebar: document.getElementById("poSavebar"),
    saveContext: document.getElementById("poSaveContext"),
    saveState: document.getElementById("poSaveState"),

    sendModal: document.getElementById("poSendModal"),
    sendTo: document.getElementById("poSendTo"),
    sendSubject: document.getElementById("poSendSubject"),
    sendBody: document.getElementById("poSendBody"),
    sendError: document.getElementById("poSendError"),
    sendConfirm: document.getElementById("poSendConfirm"),
    sendCancel: document.getElementById("poSendCancel"),

    receiveModal: document.getElementById("poReceiveModal"),
    receiveLines: document.getElementById("poReceiveLines"),
    receiveNote: document.getElementById("poReceiveNote"),
    receiveError: document.getElementById("poReceiveError"),
    receiveCancel: document.getElementById("poReceiveCancel"),
    receiveAll: document.getElementById("poReceiveAll"),
    receiveConfirm: document.getElementById("poReceiveConfirm")
  };

  const STATUS_LABELS = {
    draft: "Draft",
    sent: "Sent",
    partially_received: "Partial",
    received: "Received",
    cancelled: "Cancelled"
  };

  // Send-modal can also drive the re-send flow. Track which one is open
  // so the confirm handler routes to /send vs /resend.
  let sendModalMode = "send"; // "send" | "resend"

  const state = {
    poId: null,
    po: null,
    catalog: null,    // for line description lookups
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
  function fmtDateTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function relTime(iso) {
    if (!iso) return "";
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 5) return "just now";
    if (seconds < 60) return seconds + "s ago";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    return new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function getPoIdFromUrl() {
    const m = location.pathname.match(/^\/admin\/purchase-order\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function boot() {
    state.poId = getPoIdFromUrl();
    if (!state.poId) { showError("No purchase order id in URL."); return; }
    try {
      const [poRes, partsRes] = await Promise.all([
        fetch(`/api/purchase-orders/${encodeURIComponent(state.poId)}`, { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/parts", { cache: "force-cache" }).then((r) => r.json())
      ]);
      if (!poRes.ok || !poRes.purchaseOrder) {
        showError((poRes.errors && poRes.errors[0]) || "Couldn't load purchase order.");
        return;
      }
      state.po = poRes.purchaseOrder;
      state.catalog = partsRes && partsRes.ok ? { parts: partsRes.parts || {} } : { parts: {} };
      els.loading.hidden = true;
      els.page.hidden = false;
      els.savebar.hidden = false;
      renderAll();
      setSaveState("saved", state.po.updatedAt);
    } catch (err) {
      showError(err.message || "Couldn't load purchase order.");
    }
  }

  function showError(message) {
    els.loading.hidden = true;
    els.error.hidden = false;
    els.error.textContent = message;
  }

  function renderAll() {
    renderHeader();
    renderLines();
    renderHistory();
    renderActions();
  }

  function renderHeader() {
    els.id.textContent = state.po.id;
    els.status.className = `po-status po-status--${state.po.status}`;
    els.status.textContent = STATUS_LABELS[state.po.status] || state.po.status;
    const sourceList = (state.po.sourceMaterialListIds || [])[0];
    els.sourceList.innerHTML = sourceList
      ? `from <a href="/admin/material-list/${encodeURIComponent(sourceList)}">${escapeHtml(sourceList)}</a>`
      : "";
    els.pdfLink.href = `/api/purchase-orders/${encodeURIComponent(state.po.id)}/pdf`;
    els.pdfLink.hidden = false;

    setIfNotFocused(els.supplierName, state.po.supplierName);
    setIfNotFocused(els.supplierContactName, state.po.supplierContactName);
    setIfNotFocused(els.supplierEmail, state.po.supplierEmail);
    setIfNotFocused(els.supplierPhone, state.po.supplierPhone);
    setIfNotFocused(els.supplierAddress, state.po.supplierAddress);
    setIfNotFocused(els.notes, state.po.notes);
    setIfNotFocused(els.internalNotes, state.po.internalNotes);

    // Lock fields when not draft.
    const locked = state.po.status !== "draft";
    [els.supplierName, els.supplierContactName, els.supplierEmail, els.supplierPhone, els.supplierAddress, els.notes, els.internalNotes].forEach((el) => {
      el.readOnly = locked;
    });
    els.saveContext.textContent = locked
      ? `${STATUS_LABELS[state.po.status]} — read-only`
      : "Editable while in draft";
  }
  function setIfNotFocused(el, value) {
    if (document.activeElement !== el) el.value = value || "";
  }

  function renderLines() {
    const lines = state.po.lineItems || [];
    els.lineCount.textContent = lines.length === 1 ? "1 line" : `${lines.length} lines`;
    if (!lines.length) {
      els.linesEmpty.hidden = false;
      els.lines.innerHTML = "";
    } else {
      els.linesEmpty.hidden = true;
      const locked = state.po.status !== "draft";
      els.lines.innerHTML = lines.map((line) => {
        const part = state.catalog.parts[line.sku];
        const desc = part ? (part.description || part.sku) : `(SKU ${line.sku})`;
        const recv = Number(line.receivedQty) || 0;
        const fullyReceived = recv >= line.qty;
        let recvIndicator = "";
        if (recv > 0 && !fullyReceived) {
          recvIndicator = `<span class="po-line-recv is-partial">received ${recv} of ${line.qty}</span>`;
        } else if (fullyReceived) {
          recvIndicator = `<span class="po-line-recv">received ${recv}</span>`;
        }
        return `
          <li class="po-line ${locked ? "is-locked" : ""} ${fullyReceived ? "is-fully-received" : ""}" data-line-id="${escapeHtml(line.id)}">
            <span class="po-line-sku">${escapeHtml(line.sku)}</span>
            <span class="po-line-desc">
              ${escapeHtml(desc)}
              ${recvIndicator}
            </span>
            <span class="po-line-qty">${line.qty}</span>
            <span class="po-line-unit">${fmtCents(line.unitPriceCents)}</span>
            <span class="po-line-total">${fmtCents(line.lineTotalCents)}</span>
            <button type="button" class="po-line-remove" data-action="remove-line" aria-label="Remove line">×</button>
          </li>
        `;
      }).join("");
    }
    els.subtotal.textContent = fmtCents(state.po.subtotalCents);
  }

  function renderHistory() {
    const hist = state.po.history || [];
    els.history.innerHTML = hist.slice().reverse().map((h) => `
      <li>
        <span class="po-history-when">${escapeHtml(fmtDateTime(h.ts))}</span>
        <span class="po-history-action">${escapeHtml(h.action || "")}</span>
        <span class="po-history-note">${escapeHtml(h.note || "")}${h.by ? ` · ${escapeHtml(h.by)}` : ""}</span>
      </li>
    `).join("");
  }

  function renderActions() {
    const status = state.po.status;
    els.sendBtn.hidden = status !== "draft";
    els.deleteBtn.hidden = status !== "draft";
    els.resendBtn.hidden = status !== "sent" && status !== "partially_received";
    els.receiveBtn.hidden = status !== "sent" && status !== "partially_received";
    els.reorderBtn.hidden = status === "draft"; // anything but draft can be cloned
    els.cancelBtn.hidden = !(status === "draft" || status === "sent" || status === "partially_received");
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
      els.saveState.textContent = "Unsaved changes";
    }
  }
  setInterval(() => {
    if (els.saveState.classList.contains("is-saved") && state.lastSavedAt) {
      els.saveState.textContent = `Saved · ${relTime(state.lastSavedAt)}`;
    }
  }, 5000);

  function scheduleSave(immediate = false) {
    if (state.po.status !== "draft") return; // only drafts auto-save
    setSaveState("dirty");
    if (state.saveTimer) clearTimeout(state.saveTimer);
    if (immediate) { flushSave(); return; }
    state.saveTimer = setTimeout(flushSave, 1200);
  }

  async function flushSave() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    if (state.saving || state.po.status !== "draft") return;
    state.saving = true;
    setSaveState("saving");
    state.pendingError = null;
    try {
      const payload = {
        supplierName: state.po.supplierName,
        supplierContactName: state.po.supplierContactName,
        supplierEmail: state.po.supplierEmail,
        supplierPhone: state.po.supplierPhone,
        supplierAddress: state.po.supplierAddress,
        notes: state.po.notes,
        internalNotes: state.po.internalNotes
      };
      const r = await fetch(`/api/purchase-orders/${encodeURIComponent(state.poId)}`, {
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
      state.po = data.purchaseOrder;
      renderHeader();
      setSaveState("saved", state.po.updatedAt);
    } catch (err) {
      state.pendingError = err.message || "Save failed";
      setSaveState("error");
    } finally {
      state.saving = false;
    }
  }

  function bindFieldInput(input, fieldName) {
    input.addEventListener("input", () => {
      state.po[fieldName] = input.value;
      scheduleSave();
    });
    input.addEventListener("blur", () => {
      if (state.saveTimer || state.pendingError) flushSave();
    });
  }

  // ---- Send modal (used for both initial send + re-send) ------------
  function openSendModal({ mode } = {}) {
    sendModalMode = mode === "resend" ? "resend" : "send";
    els.sendError.hidden = true;
    els.sendTo.value = state.po.emailedToEmail || state.po.supplierEmail || "";
    els.sendSubject.value = state.po.emailSubject || `Purchase Order ${state.po.id} from PJL Land Services`;
    els.sendBody.value = "";
    els.sendModal.querySelector("h3").textContent = sendModalMode === "resend"
      ? "Re-send PDF to supplier"
      : "Send purchase order";
    els.sendConfirm.textContent = sendModalMode === "resend" ? "Re-send PDF" : "Send PDF";
    els.sendModal.hidden = false;
    setTimeout(() => els.sendTo.focus(), 100);
  }
  function closeSendModal() {
    els.sendModal.hidden = true;
  }
  async function confirmSend() {
    const toEmail = els.sendTo.value.trim();
    if (!toEmail) {
      els.sendError.textContent = "Recipient email is required.";
      els.sendError.hidden = false;
      els.sendTo.focus();
      return;
    }
    els.sendConfirm.disabled = true;
    try {
      const endpoint = sendModalMode === "resend" ? "resend" : "send";
      const r = await fetch(`/api/purchase-orders/${encodeURIComponent(state.poId)}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toEmail,
          subject: els.sendSubject.value,
          bodyText: els.sendBody.value
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.sendError.textContent = (data.errors && data.errors[0]) || `${sendModalMode === "resend" ? "Re-send" : "Send"} failed (${r.status})`;
        els.sendError.hidden = false;
        return;
      }
      state.po = data.purchaseOrder;
      closeSendModal();
      renderAll();
    } catch (err) {
      els.sendError.textContent = err.message || "Send failed.";
      els.sendError.hidden = false;
    } finally {
      els.sendConfirm.disabled = false;
    }
  }

  // ---- Receive modal (per-line partial-receive support) ------------
  // Each row's input is the "received THIS delivery" delta — defaults
  // to the still-outstanding qty so a "click confirm" round-trip works
  // for the common full-delivery case. We add the delta to the line's
  // existing receivedQty before sending the absolute total to the server.
  function openReceiveModal() {
    els.receiveError.hidden = true;
    els.receiveNote.value = "";
    const lines = state.po.lineItems || [];
    els.receiveLines.innerHTML = lines.map((line) => {
      const part = state.catalog.parts[line.sku];
      const desc = part ? (part.description || part.sku) : `(SKU ${line.sku})`;
      const recv = Number(line.receivedQty) || 0;
      const remaining = Math.max(0, line.qty - recv);
      const fullyReceived = remaining === 0;
      return `
        <div class="po-receive-row ${fullyReceived ? "is-fully-received" : ""}" data-line-id="${escapeHtml(line.id)}">
          <div class="po-receive-info">
            <div class="po-receive-desc">${escapeHtml(desc)}</div>
            <div class="po-receive-meta">
              <span style="font-family:ui-monospace,monospace">${escapeHtml(line.sku)}</span> ·
              ordered <strong>${line.qty}</strong> ·
              already received <strong>${recv}</strong>${fullyReceived ? " (complete)" : ""}
            </div>
          </div>
          <div class="po-receive-input-wrap">
            <input type="number" class="po-receive-input" min="0" max="${remaining}"
              value="${remaining}" data-remaining="${remaining}"
              ${fullyReceived ? "disabled" : ""} aria-label="Received this delivery">
            <span class="po-receive-of">of ${remaining}</span>
          </div>
        </div>
      `;
    }).join("");
    els.receiveModal.hidden = false;
  }
  function closeReceiveModal() {
    els.receiveModal.hidden = true;
  }
  function setReceiveAllRemaining() {
    els.receiveLines.querySelectorAll("input.po-receive-input").forEach((input) => {
      if (input.disabled) return;
      input.value = input.dataset.remaining;
    });
  }
  async function confirmReceive() {
    // Build the absolute lineUpdates map — server expects new totals,
    // not deltas, so we add the delta-input value to the line's prior
    // receivedQty.
    const lineUpdates = {};
    let anyChange = false;
    els.receiveLines.querySelectorAll("[data-line-id]").forEach((row) => {
      const lineId = row.dataset.lineId;
      const input = row.querySelector("input.po-receive-input");
      if (!input || input.disabled) return;
      const delta = Math.max(0, Math.floor(Number(input.value) || 0));
      if (delta <= 0) return;
      const line = state.po.lineItems.find((l) => l.id === lineId);
      if (!line) return;
      const newTotal = Math.min((Number(line.receivedQty) || 0) + delta, line.qty);
      if (newTotal !== line.receivedQty) {
        lineUpdates[lineId] = newTotal;
        anyChange = true;
      }
    });
    if (!anyChange) {
      els.receiveError.textContent = "No deliveries entered. Set at least one line's quantity above 0.";
      els.receiveError.hidden = false;
      return;
    }
    els.receiveConfirm.disabled = true;
    try {
      const r = await fetch(`/api/purchase-orders/${encodeURIComponent(state.poId)}/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineUpdates, note: els.receiveNote.value || "" })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.receiveError.textContent = (data.errors && data.errors[0]) || `Receive failed (${r.status})`;
        els.receiveError.hidden = false;
        return;
      }
      state.po = data.purchaseOrder;
      closeReceiveModal();
      renderAll();
    } catch (err) {
      els.receiveError.textContent = err.message || "Receive failed.";
      els.receiveError.hidden = false;
    } finally {
      els.receiveConfirm.disabled = false;
    }
  }

  // ---- Reorder ------------------------------------------------------
  async function reorderPo() {
    if (!confirm("Clone this PO into a new draft? Same supplier, same line items at fresh prices from the catalog.")) return;
    const r = await fetch(`/api/purchase-orders/${encodeURIComponent(state.poId)}/reorder`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) { alert((data.errors && data.errors[0]) || "Couldn't re-order."); return; }
    location.href = `/admin/purchase-order/${encodeURIComponent(data.purchaseOrder.id)}`;
  }

  async function cancelPo() {
    const reason = prompt("Cancel this PO. Reason (optional):", "");
    if (reason === null) return;
    const r = await fetch(`/api/purchase-orders/${encodeURIComponent(state.poId)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) { alert((data.errors && data.errors[0]) || "Couldn't cancel."); return; }
    state.po = data.purchaseOrder;
    renderAll();
  }

  async function deleteDraft() {
    if (!confirm("Delete this draft PO? This cannot be undone.")) return;
    const r = await fetch(`/api/purchase-orders/${encodeURIComponent(state.poId)}`, { method: "DELETE" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) { alert((data.errors && data.errors[0]) || "Couldn't delete."); return; }
    location.href = "/admin/purchase-orders";
  }

  // ---- Wire events --------------------------------------------------
  function wire() {
    bindFieldInput(els.supplierName, "supplierName");
    bindFieldInput(els.supplierContactName, "supplierContactName");
    bindFieldInput(els.supplierEmail, "supplierEmail");
    bindFieldInput(els.supplierPhone, "supplierPhone");
    bindFieldInput(els.supplierAddress, "supplierAddress");
    bindFieldInput(els.notes, "notes");
    bindFieldInput(els.internalNotes, "internalNotes");

    els.sendBtn.addEventListener("click", () => openSendModal({ mode: "send" }));
    els.resendBtn.addEventListener("click", () => openSendModal({ mode: "resend" }));
    els.sendCancel.addEventListener("click", closeSendModal);
    els.sendModal.addEventListener("click", (event) => {
      if (event.target === els.sendModal) closeSendModal();
    });
    els.sendConfirm.addEventListener("click", confirmSend);

    els.receiveBtn.addEventListener("click", openReceiveModal);
    els.receiveCancel.addEventListener("click", closeReceiveModal);
    els.receiveModal.addEventListener("click", (event) => {
      if (event.target === els.receiveModal) closeReceiveModal();
    });
    els.receiveAll.addEventListener("click", setReceiveAllRemaining);
    els.receiveConfirm.addEventListener("click", confirmReceive);

    els.reorderBtn.addEventListener("click", reorderPo);
    els.cancelBtn.addEventListener("click", cancelPo);
    els.deleteBtn.addEventListener("click", deleteDraft);

    window.addEventListener("beforeunload", () => {
      if (!state.saveTimer && !state.pendingError) return;
      try {
        const payload = {
          supplierName: state.po.supplierName,
          supplierContactName: state.po.supplierContactName,
          supplierEmail: state.po.supplierEmail,
          supplierPhone: state.po.supplierPhone,
          supplierAddress: state.po.supplierAddress,
          notes: state.po.notes,
          internalNotes: state.po.internalNotes
        };
        fetch(`/api/purchase-orders/${encodeURIComponent(state.poId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true
        });
      } catch {}
    });
  }

  wire();
  boot();
})();
