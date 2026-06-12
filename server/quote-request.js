// Quote Request (RFQ) detail — Phase A (document + send) and Phase B
// (price quick-grid + apply-to-catalog).
// Status-aware sibling of the PO detail page, with two deliberate
// differences from purchase-order.js:
//   1. Prices here are the VENDOR'S, never ours. A draft shows no price
//      column at all — an RFQ goes out price-free. Once sent, the
//      quick-grid records what the vendor quoted (quotedPriceCents);
//      applied/cancelled fall back to the read-only quoted cell.
//   2. Supplier identity is read-only. PATCH /api/quote-requests/:id only
//      accepts {lines, notes} (draft) or {quotedPrices} (sent/quoted) —
//      the supplier block is a snapshot from generation, so a wrong email
//      gets fixed on the supplier record and the RFQ regenerated
//      (generation refreshes same-supplier drafts).
// Drafts: qty edits + remove-line + notes auto-save (1.2s debounce, same
// savebar pattern as the PO page). Sent/quoted: that SAME debounce drives
// the price grid — PATCH { quotedPrices: { lineId: cents|null } } with
// only the entries the user touched; the server flips sent→quoted at the
// first priced line and back to sent when all are cleared. Quoted adds
// the Review & apply flow, which writes the parts catalog (supplier cost)
// and lands the RFQ in its terminal "applied" state.
// Core design rule inherited from generation: nothing on this page ever
// touches material-list line status — lines stay "need" through send,
// quote, and apply (apply updates the CATALOG; open material lists pick
// the new prices up live).

(function () {
  const els = {
    loading: document.getElementById("qrLoading"),
    error: document.getElementById("qrError"),
    page: document.getElementById("qrPage"),
    id: document.getElementById("qrId"),
    status: document.getElementById("qrStatus"),
    sourceList: document.getElementById("qrSourceList"),
    pdfLink: document.getElementById("qrPdfLink"),
    csvLink: document.getElementById("qrCsvLink"),
    cancelledBanner: document.getElementById("qrCancelledBanner"),

    supplierName: document.getElementById("qrSupplierName"),
    supplierContact: document.getElementById("qrSupplierContact"),
    supplierEmail: document.getElementById("qrSupplierEmail"),
    supplierPhone: document.getElementById("qrSupplierPhone"),
    createdAt: document.getElementById("qrCreatedAt"),
    sentAt: document.getElementById("qrSentAt"),
    notes: document.getElementById("qrNotes"),

    lineCount: document.getElementById("qrLineCount"),
    pricedCount: document.getElementById("qrPricedCount"),
    linesEmpty: document.getElementById("qrLinesEmpty"),
    lines: document.getElementById("qrLines"),

    history: document.getElementById("qrHistory"),

    sendBtn: document.getElementById("qrSendButton"),
    applyBtn: document.getElementById("qrApplyButton"),
    resendBtn: document.getElementById("qrResendButton"),
    cancelBtn: document.getElementById("qrCancelButton"),

    savebar: document.getElementById("qrSavebar"),
    saveContext: document.getElementById("qrSaveContext"),
    saveState: document.getElementById("qrSaveState"),

    sendModal: document.getElementById("qrSendModal"),
    sendTo: document.getElementById("qrSendTo"),
    sendSubject: document.getElementById("qrSendSubject"),
    sendBody: document.getElementById("qrSendBody"),
    sendError: document.getElementById("qrSendError"),
    sendConfirm: document.getElementById("qrSendConfirm"),
    sendCancel: document.getElementById("qrSendCancel"),

    applyModal: document.getElementById("qrApplyModal"),
    applyRows: document.getElementById("qrApplyRows"),
    applySummary: document.getElementById("qrApplySummary"),
    applyError: document.getElementById("qrApplyError"),
    applyConfirm: document.getElementById("qrApplyConfirm"),
    applyCancel: document.getElementById("qrApplyCancel")
  };

  const STATUS_LABELS = {
    draft: "Draft",
    sent: "Sent",
    quoted: "Quoted",
    applied: "Applied",
    cancelled: "Cancelled"
  };

  // Send-modal also drives the re-send flow. Track which one is open so
  // the confirm handler routes to /send vs /resend. Re-send re-attaches
  // the frozen documents byte-identical and keeps the original subject,
  // so the subject field is disabled in resend mode.
  let sendModalMode = "send"; // "send" | "resend"

  const state = {
    qrId: null,
    qr: null,
    catalog: null,       // description fallback + "current price" column in the apply review
    saveTimer: null,
    saving: false,
    savePromise: null,   // resolves when the in-flight PATCH settles — apply drains on it
    pendingError: null,
    lastSavedAt: null,
    pendingQuotes: {},   // lineId → cents|null — price-grid edits not yet PATCHed
    applying: false      // apply-to-catalog POST in flight (locks the modal)
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function fmtCents(c) { return "$" + ((Number(c) || 0) / 100).toFixed(2); }
  // Description resolver — mirror of resolveLineDescription in
  // server/lib/format.js (the page can't require server code). Stored line
  // description → catalog by SKU → "(SKU …)" placeholder. RFQ lines snapshot
  // their description at generation, so the catalog branch is belt-and-
  // braces for records hydrated from older data.
  function resolveLineDescription(line) {
    const stored = line && typeof line.description === "string" ? line.description.trim() : "";
    if (stored) return stored;
    const parts = state.catalog && state.catalog.parts ? state.catalog.parts : null;
    const part = parts && line ? parts[line.sku] : null;
    const catalogDesc = part && typeof part.description === "string" ? part.description.trim() : "";
    if (catalogDesc) return catalogDesc;
    return `(SKU ${line ? line.sku : ""})`;
  }
  // The price quick-grid is live exactly while the vendor could still be
  // answering — sent (waiting) and quoted (partially/fully answered).
  function canEnterQuotes() {
    return !!state.qr && (state.qr.status === "sent" || state.qr.status === "quoted");
  }
  // Dollars-text → integer cents. Empty/whitespace clears the quote (null);
  // "0" is a real answer (free item — 0 cents). This is paste-from-vendor-
  // email territory, so strip a leading $ and thousands commas first (the
  // same clean step as lib/parts.js coerceDollarsToCents) and then validate
  // STRICTLY — bare parseFloat would stop at the first comma and turn
  // "1,049.00" into $1.00 silently, and accept trailing garbage ("12abc")
  // and scientific notation ("1e3"). Anything that isn't a plain decimal
  // number comes back !ok: the caller leaves state untouched and the
  // "change" handler snaps the input back to its last accepted value.
  function parseDollarsToCents(v) {
    const s = String(v == null ? "" : v).trim().replace(/^\$/, "");
    if (!s) return { ok: true, cents: null };
    // Commas only as CORRECTLY-PLACED thousands separators ("1,049.00") —
    // stripping them blindly would turn a European-decimal "2,39" into
    // $239.00 instead of rejecting it for the admin to disambiguate.
    if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return { ok: false, cents: null };
    const n = Number(s.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) return { ok: false, cents: null };
    return { ok: true, cents: Math.round(n * 100) };
  }
  // A line's quoted price as the user currently sees it — the dirty entry
  // if they've touched it this session, otherwise what the server has.
  function effectiveQuoteCents(line) {
    if (Object.prototype.hasOwnProperty.call(state.pendingQuotes, line.id)) return state.pendingQuotes[line.id];
    return line.quotedPriceCents == null ? null : line.quotedPriceCents;
  }
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
  function getQrIdFromUrl() {
    const m = location.pathname.match(/^\/admin\/quote-request\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function boot() {
    state.qrId = getQrIdFromUrl();
    if (!state.qrId) { showError("No quote request id in URL."); return; }
    try {
      const [qrRes, partsRes] = await Promise.all([
        fetch(`/api/quote-requests/${encodeURIComponent(state.qrId)}`, { cache: "no-store" }).then((r) => r.json()),
        // The catalog is only a description fallback here — RFQ lines never
        // carry catalog prices — but keep it no-store like the PO page so a
        // freshly-added SKU's description shows up without a hard refresh.
        fetch("/api/parts", { cache: "no-store" }).then((r) => r.json())
      ]);
      if (!qrRes.ok || !qrRes.quoteRequest) {
        showError((qrRes.errors && qrRes.errors[0]) || "Couldn't load quote request.");
        return;
      }
      state.qr = qrRes.quoteRequest;
      state.catalog = partsRes && partsRes.ok ? { parts: partsRes.parts || {} } : { parts: {} };
      els.loading.hidden = true;
      els.page.hidden = false;
      els.savebar.hidden = false;
      renderAll();
      setSaveState("saved", state.qr.updatedAt);
    } catch (err) {
      showError(err.message || "Couldn't load quote request.");
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
    els.id.textContent = state.qr.id;
    els.status.className = `qr-status qr-status--${state.qr.status}`;
    els.status.textContent = STATUS_LABELS[state.qr.status] || state.qr.status;
    const sourceList = state.qr.sourceMaterialListId;
    els.sourceList.innerHTML = sourceList
      ? `from <a href="/admin/material-list/${encodeURIComponent(sourceList)}">${escapeHtml(sourceList)}</a>`
      : "";
    els.pdfLink.href = `/api/quote-requests/${encodeURIComponent(state.qr.id)}/pdf`;
    els.pdfLink.hidden = false;
    // CSV is frozen alongside the PDF on send; for drafts it's a live
    // render. Either way the endpoint always returns something.
    els.csvLink.href = `/api/quote-requests/${encodeURIComponent(state.qr.id)}/csv`;
    els.csvLink.hidden = false;

    // Supplier block — read-only snapshot (see header comment).
    els.supplierName.textContent = state.qr.supplierName || "—";
    els.supplierContact.textContent = state.qr.supplierContactName || "—";
    els.supplierEmail.textContent = state.qr.supplierEmail || "—";
    els.supplierPhone.textContent = state.qr.supplierPhone || "—";
    els.createdAt.textContent = fmtDateTime(state.qr.createdAt);
    els.sentAt.textContent = state.qr.sentAt ? fmtDateTime(state.qr.sentAt) : "—";

    setIfNotFocused(els.notes, state.qr.notes);

    // Cancelled banner: the only place cancelReason surfaces on-page.
    if (state.qr.status === "cancelled") {
      const reason = (state.qr.cancelReason || "").trim();
      els.cancelledBanner.textContent =
        `This quote request was cancelled ${state.qr.cancelledAt ? "on " + fmtDateTime(state.qr.cancelledAt) : ""}`.trim()
        + (reason ? ` — ${reason}` : ".");
      els.cancelledBanner.hidden = false;
    } else {
      els.cancelledBanner.hidden = true;
    }

    // Lock notes when not draft. The savebar stays honest about what's
    // still editable: sent/quoted keep autosave alive for the price grid.
    const locked = state.qr.status !== "draft";
    els.notes.readOnly = locked;
    els.saveContext.textContent = !locked
      ? "Editable while in draft"
      : canEnterQuotes()
        ? "Vendor prices editable — auto-saves"
        : `${STATUS_LABELS[state.qr.status] || state.qr.status} — read-only`;
  }
  function setIfNotFocused(el, value) {
    if (document.activeElement !== el) el.value = value || "";
  }

  function renderLines() {
    const lines = state.qr.lines || [];
    els.lineCount.textContent = lines.length === 1 ? "1 line" : `${lines.length} lines`;
    // Price column by status:
    //   draft             — none at all. An RFQ draft shows no prices, full
    //                       stop (the ask goes out price-free).
    //   sent / quoted     — Phase B quick-grid: an editable "vendor quoted"
    //                       dollars input per line, autosaved like drafts.
    //   applied/cancelled — the read-only quoted cell, and only when at
    //                       least one line actually carries a price (a
    //                       cancelled-before-answer RFQ stays price-free).
    const quoting = canEnterQuotes();
    const anyQuoted = lines.some((line) => line.quotedPriceCents != null);
    const showQuotedReadOnly = !quoting && state.qr.status !== "draft" && anyQuoted;
    els.lines.classList.toggle("qr-lines--quoting", quoting);
    els.lines.classList.toggle("qr-lines--quoted", showQuotedReadOnly);
    renderPricedCount();
    if (!lines.length) {
      els.linesEmpty.hidden = false;
      els.lines.innerHTML = "";
      return;
    }
    els.linesEmpty.hidden = true;
    const locked = state.qr.status !== "draft";
    els.lines.innerHTML = lines.map((line) => {
      const desc = resolveLineDescription(line);
      const qty = Math.max(1, Math.floor(Number(line.quantity) || 1));
      const qtyCell = locked
        ? `<span class="qr-line-qty">${qty}</span>`
        : `<span class="qr-line-qty"><input type="number" class="qr-line-qty-input" min="1" step="1" inputmode="numeric" value="${qty}" aria-label="Quantity"></span>`;
      let priceCell = "";
      if (quoting) {
        // Prefill from the merged view so a mid-debounce re-render doesn't
        // wipe a value the user just typed but hasn't saved yet.
        const cents = effectiveQuoteCents(line);
        const value = cents == null ? "" : (cents / 100).toFixed(2);
        priceCell = `<span class="qr-line-quote-edit"><span class="qr-line-quote-field"><span class="qr-line-quote-prefix" aria-hidden="true">$</span><input type="text" class="qr-line-quote-input" inputmode="decimal" autocomplete="off" value="${escapeHtml(value)}" placeholder="0.00" aria-label="Vendor quoted unit price for ${escapeHtml(line.sku)}, in dollars"></span></span>`;
      } else if (showQuotedReadOnly) {
        priceCell = `<span class="qr-line-quoted" title="Vendor quoted unit price">${line.quotedPriceCents != null ? fmtCents(line.quotedPriceCents) : "—"}</span>`;
      }
      return `
        <li class="qr-line ${locked ? "is-locked" : ""}" data-line-id="${escapeHtml(line.id)}">
          <span class="qr-line-sku">${escapeHtml(line.sku)}</span>
          <span class="qr-line-desc">${escapeHtml(desc)}</span>
          ${qtyCell}
          <span class="qr-line-unit">${escapeHtml(line.unit || "each")}</span>
          ${priceCell}
          <button type="button" class="qr-line-remove" data-action="remove-line" aria-label="Remove line">×</button>
        </li>
      `;
    }).join("");
  }

  // "N of M priced" — counts the user's CURRENT view (dirty entries
  // included) so the number moves with the keystroke, not 1.2s later.
  // Shown while the grid is live and kept as a receipt on applied.
  function renderPricedCount() {
    const lines = state.qr.lines || [];
    const show = (canEnterQuotes() || state.qr.status === "applied") && lines.length > 0;
    els.pricedCount.hidden = !show;
    if (!show) return;
    const priced = lines.filter((line) => effectiveQuoteCents(line) != null).length;
    els.pricedCount.textContent = `${priced} of ${lines.length} priced`;
    els.pricedCount.classList.toggle("is-complete", priced === lines.length);
  }

  function renderHistory() {
    const hist = state.qr.history || [];
    els.history.innerHTML = hist.slice().reverse().map((h) => `
      <li>
        <span class="qr-history-when">${escapeHtml(fmtDateTime(h.ts))}</span>
        <span class="qr-history-action">${escapeHtml(h.action || "")}</span>
        <span class="qr-history-note">${escapeHtml(h.note || "")}${h.by ? ` · ${escapeHtml(h.by)}` : ""}</span>
      </li>
    `).join("");
  }

  function renderActions() {
    const status = state.qr.status;
    els.sendBtn.hidden = status !== "draft";
    // Apply is the quoted-only primary action — the server 422s anything
    // else, and applied is terminal (the status guard blocks double-apply).
    els.applyBtn.hidden = status !== "quoted";
    els.resendBtn.hidden = status !== "sent";
    // quoted/applied are answered RFQs — cancelling one makes no sense, so
    // cancel stops being offered the moment the vendor responds.
    els.cancelBtn.hidden = !(status === "draft" || status === "sent");
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
    // Drafts auto-save {lines, notes}; sent/quoted auto-save the price
    // grid as {quotedPrices}. applied/cancelled never save.
    if (state.qr.status !== "draft" && !canEnterQuotes()) return;
    setSaveState("dirty");
    if (state.saveTimer) clearTimeout(state.saveTimer);
    if (immediate) { flushSave(); return; }
    state.saveTimer = setTimeout(flushSave, 1200);
  }

  function buildSavePayload() {
    // sent/quoted: the only PATCHable thing is the vendor's prices — send
    // just the entries the user touched ({ lineId: cents|null }); the
    // server validates per-line and flips status sent↔quoted itself.
    if (state.qr.status !== "draft") {
      return { quotedPrices: { ...state.pendingQuotes } };
    }
    return {
      notes: state.qr.notes,
      lines: (state.qr.lines || []).map((line) => ({
        id: line.id,
        sku: line.sku,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        quotedPriceCents: line.quotedPriceCents == null ? null : line.quotedPriceCents
      }))
    };
  }

  async function flushSave() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    // Mid-flight call (debounce fired while a PATCH is out): RESCHEDULE
    // rather than drop — the timer was just cleared above, so returning
    // here without one would strand whatever's dirty (same guard as the
    // material-list builder's flushSave).
    if (state.saving) {
      state.saveTimer = setTimeout(flushSave, 200);
      return;
    }
    const quoteMode = canEnterQuotes();
    if (state.qr.status !== "draft" && !quoteMode) return;
    // Price-grid saves only go out when something is actually dirty — the
    // server records every entry it receives, so an empty map is a no-op.
    if (quoteMode && !Object.keys(state.pendingQuotes).length) {
      setSaveState("saved", state.qr.updatedAt);
      return;
    }
    state.saving = true;
    setSaveState("saving");
    state.pendingError = null;
    // Snapshot what's going out so entries the user re-edits while the
    // request is in flight stay dirty and flush on the next pass.
    const sentQuotes = quoteMode ? { ...state.pendingQuotes } : null;
    let resolveFlight;
    // The apply flow awaits this to drain in-flight saves before reviewing.
    state.savePromise = new Promise((resolve) => { resolveFlight = resolve; });
    try {
      const r = await fetch(`/api/quote-requests/${encodeURIComponent(state.qrId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(quoteMode ? { quotedPrices: sentQuotes } : buildSavePayload())
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        state.pendingError = (data.errors && data.errors[0]) || `Save failed (${r.status})`;
        setSaveState("error");
        return;
      }
      if (quoteMode) {
        for (const [lineId, cents] of Object.entries(sentQuotes)) {
          if (state.pendingQuotes[lineId] === cents) delete state.pendingQuotes[lineId];
        }
      }
      state.qr = data.quoteRequest;
      renderHeader();
      renderActions(); // a sent↔quoted flip swaps Re-send/Cancel for Apply
      // Re-render lines only when the user isn't mid-edit in the table —
      // a wholesale innerHTML swap would steal focus from the qty/price
      // input. The priced counter is safe to refresh either way.
      if (!els.lines.contains(document.activeElement)) renderLines();
      else renderPricedCount();
      setSaveState("saved", state.qr.updatedAt);
    } catch (err) {
      state.pendingError = err.message || "Save failed";
      setSaveState("error");
    } finally {
      state.saving = false;
      state.savePromise = null;
      resolveFlight();
    }
  }

  function findLineFromEvent(event) {
    const li = event.target.closest(".qr-line");
    if (!li) return null;
    return (state.qr.lines || []).find((line) => line.id === li.dataset.lineId) || null;
  }

  // ---- Send modal (used for both initial send + re-send) ------------
  function openSendModal({ mode } = {}) {
    sendModalMode = mode === "resend" ? "resend" : "send";
    els.sendError.hidden = true;
    els.sendTo.value = state.qr.emailedToEmail || state.qr.supplierEmail || "";
    // Default subject matches buildRfqSubject in lib/notify-supplier.js —
    // keep the two in sync so a user-untouched subject equals the server's.
    const n = (state.qr.lines || []).length;
    els.sendSubject.value = state.qr.emailSubject || `${state.qr.id} — PJL Land Services — Request for Quotation — ${n} item${n === 1 ? "" : "s"}`;
    // Re-send re-attaches the frozen documents under the original subject —
    // the /resend endpoint only takes {toEmail, bodyText}.
    els.sendSubject.disabled = sendModalMode === "resend";
    els.sendBody.value = "";
    els.sendModal.querySelector("h3").textContent = sendModalMode === "resend"
      ? "Re-send PDF to vendor"
      : "Send quote request";
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
      const payload = endpoint === "resend"
        ? { toEmail, bodyText: els.sendBody.value }
        : { toEmail, subject: els.sendSubject.value, bodyText: els.sendBody.value };
      const r = await fetch(`/api/quote-requests/${encodeURIComponent(state.qrId)}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.sendError.textContent = (data.errors && data.errors[0]) || `${sendModalMode === "resend" ? "Re-send" : "Send"} failed (${r.status})`;
        els.sendError.hidden = false;
        return;
      }
      state.qr = data.quoteRequest;
      closeSendModal();
      renderAll();
    } catch (err) {
      els.sendError.textContent = err.message || "Send failed.";
      els.sendError.hidden = false;
    } finally {
      els.sendConfirm.disabled = false;
    }
  }

  async function cancelQr() {
    const reason = prompt("Cancel this quote request. Reason (optional):", "");
    if (reason === null) return;
    const r = await fetch(`/api/quote-requests/${encodeURIComponent(state.qrId)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) { alert((data.errors && data.errors[0]) || "Couldn't cancel."); return; }
    state.qr = data.quoteRequest;
    renderAll();
  }

  // ---- Review & apply modal (quoted → applied) -----------------------
  // The preview is computed client-side from the catalog the page already
  // loaded; the server recomputes everything on POST (and is the truth for
  // applied/unchanged/skipped), so this is purely a "show me what's about
  // to happen" surface before a write that fans out to open material lists.
  function buildApplyRows() {
    const lines = state.qr.lines || [];
    const parts = (state.catalog && state.catalog.parts) || {};
    const priced = lines.filter((line) => line.quotedPriceCents != null);
    const unpriced = lines.filter((line) => line.quotedPriceCents == null);
    const pricedRows = priced.map((line) => {
      const toCents = line.quotedPriceCents;
      const part = parts[line.sku];
      let priceHtml;
      let noteHtml = "";
      if (!part) {
        // SKU vanished from the catalog since quoting — the server will
        // skip it, so say so up front instead of surprising in the summary.
        priceHtml = `<strong>${escapeHtml(fmtCents(toCents))}</strong>`;
        noteHtml = `<span class="qr-apply-note qr-apply-note--skip">not in catalog — will be skipped</span>`;
      } else {
        const fromCents = Number(part.priceCents);
        const fromHtml = Number.isFinite(fromCents) ? escapeHtml(fmtCents(fromCents)) : "—";
        // No numeric catalog price (part exists but priceCents is junk):
        // there's no delta to compare — say "new price" rather than letting
        // NaN comparisons fall through to a misleading ▼.
        const marker = !Number.isFinite(fromCents)
          ? `<span class="qr-apply-delta qr-apply-delta--same">new price</span>`
          : fromCents === toCents
            ? `<span class="qr-apply-delta qr-apply-delta--same">no change</span>`
            : toCents > fromCents
              ? `<span class="qr-apply-delta qr-apply-delta--up" title="Price increase">▲</span>`
              : `<span class="qr-apply-delta qr-apply-delta--down" title="Price decrease">▼</span>`;
        priceHtml = `${fromHtml} → <strong>${escapeHtml(fmtCents(toCents))}</strong> ${marker}`;
      }
      return `
        <li class="qr-apply-row">
          <span class="qr-apply-sku">${escapeHtml(line.sku)}</span>
          <span class="qr-apply-prices">${priceHtml}</span>
          <span class="qr-apply-desc">${escapeHtml(resolveLineDescription(line))}</span>
          ${noteHtml}
        </li>
      `;
    });
    const unpricedRows = unpriced.map((line) => `
      <li class="qr-apply-row qr-apply-row--unpriced">
        <span class="qr-apply-sku">${escapeHtml(line.sku)}</span>
        <span class="qr-apply-desc">${escapeHtml(resolveLineDescription(line))}</span>
        <span class="qr-apply-note">no quote returned — catalog unchanged</span>
      </li>
    `);
    return pricedRows.join("") + unpricedRows.join("");
  }

  function openApplyModal() {
    els.applyError.hidden = true;
    els.applySummary.hidden = true;
    els.applyConfirm.hidden = false;
    els.applyConfirm.disabled = false;
    els.applyCancel.textContent = "Cancel";
    els.applyRows.innerHTML = buildApplyRows();
    els.applyModal.hidden = false;
    // Move keyboard focus into the dialog — without this, focus stays
    // behind the aria-modal backdrop and keyboard/screen-reader users
    // can't reach the confirm button.
    els.applyConfirm.focus();
  }
  function closeApplyModal() {
    if (state.applying) return; // never dismiss a POST mid-flight
    els.applyModal.hidden = true;
  }
  async function confirmApply() {
    // Belt-and-braces vs the drain in the Apply-button handler: the modal
    // can sit open while a new edit lands (keyboard, second tab). Never
    // confirm against a review the user didn't actually see.
    if (Object.keys(state.pendingQuotes).length || state.saving || state.saveTimer) {
      els.applyError.textContent = "A price edit is still saving — close and re-open the review.";
      els.applyError.hidden = false;
      return;
    }
    els.applyError.hidden = true;
    els.applyConfirm.disabled = true;
    state.applying = true;
    try {
      const r = await fetch(`/api/quote-requests/${encodeURIComponent(state.qrId)}/apply-to-catalog`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.applyError.textContent = (data.errors && data.errors[0]) || `Apply failed (${r.status})`;
        els.applyError.hidden = false;
        els.applyConfirm.disabled = false;
        return;
      }
      // Applied — terminal. Swap the modal into its receipt state (green
      // summary + Close) instead of vanishing under the user, and bring
      // the local catalog copy up to date so anything rendered from it
      // (description fallback, a hypothetical re-open) shows new prices.
      state.qr = data.quoteRequest;
      state.pendingQuotes = {};
      for (const entry of data.applied || []) {
        const part = state.catalog && state.catalog.parts ? state.catalog.parts[entry.sku] : null;
        if (part) part.priceCents = entry.toCents;
      }
      renderAll();
      setSaveState("saved", state.qr.updatedAt);
      const appliedN = (data.applied || []).length;
      const unchangedN = (data.unchanged || []).length;
      const skippedN = (data.skipped || []).length;
      const bits = [`${appliedN} price${appliedN === 1 ? "" : "s"} applied`];
      if (unchangedN) bits.push(`${unchangedN} unchanged`);
      if (skippedN) bits.push(`${skippedN} skipped`);
      els.applySummary.textContent = `${bits.join(", ")}. Open material lists now price from the updated catalog.`;
      els.applySummary.hidden = false;
      els.applyConfirm.hidden = true;
      els.applyCancel.textContent = "Close";
    } catch (err) {
      els.applyError.textContent = err.message || "Apply failed.";
      els.applyError.hidden = false;
      els.applyConfirm.disabled = false;
    } finally {
      state.applying = false;
    }
  }

  // ---- Wire events --------------------------------------------------
  function wire() {
    els.notes.addEventListener("input", () => {
      state.qr.notes = els.notes.value;
      scheduleSave();
    });
    els.notes.addEventListener("blur", () => {
      if (state.saveTimer || state.pendingError) flushSave();
    });

    // Qty edits — delegated, drafts only. While typing we accept the value
    // into state as soon as it parses to a whole number ≥ 1, but never
    // rewrite the input mid-keystroke (no cursor fights); "change" fires on
    // commit and snaps the display back to the normalized quantity.
    els.lines.addEventListener("input", (event) => {
      if (!event.target.matches(".qr-line-qty-input")) return;
      if (state.qr.status !== "draft") return;
      const line = findLineFromEvent(event);
      if (!line) return;
      const n = Math.floor(Number(event.target.value));
      if (!Number.isFinite(n) || n < 1) { setSaveState("dirty"); return; }
      line.quantity = n;
      scheduleSave();
    });
    els.lines.addEventListener("change", (event) => {
      if (!event.target.matches(".qr-line-qty-input")) return;
      const line = findLineFromEvent(event);
      if (line) event.target.value = Math.max(1, Math.floor(Number(line.quantity) || 1));
    });

    // Vendor price entry — delegated, sent/quoted only. Same accept-while-
    // typing contract as qty: a value lands in the dirty map as soon as it
    // parses (empty = clear the quote), we never rewrite the input mid-
    // keystroke, and "change" snaps the display back to the last accepted
    // value — which is also how a negative/NaN entry gets reverted.
    els.lines.addEventListener("input", (event) => {
      if (!event.target.matches(".qr-line-quote-input")) return;
      if (!canEnterQuotes()) return;
      const line = findLineFromEvent(event);
      if (!line) return;
      const parsed = parseDollarsToCents(event.target.value);
      if (!parsed.ok) { setSaveState("dirty"); return; }
      const stored = line.quotedPriceCents == null ? null : line.quotedPriceCents;
      // Only entries the user actually CHANGED go in the PATCH — typing a
      // price back to what the server already has un-dirties the line.
      // EXCEPT mid-flight: state.qr is the PRE-save record then, so the
      // comparison baseline is stale — un-dirtying would silently lose a
      // revert (the in-flight PATCH still commits the old edit). Keep the
      // entry dirty instead; the worst case is a redundant no-op PATCH.
      if (!state.saving && parsed.cents === stored) delete state.pendingQuotes[line.id];
      else state.pendingQuotes[line.id] = parsed.cents;
      renderPricedCount();
      scheduleSave();
    });
    els.lines.addEventListener("change", (event) => {
      if (!event.target.matches(".qr-line-quote-input")) return;
      const line = findLineFromEvent(event);
      if (!line) return;
      const cents = effectiveQuoteCents(line);
      event.target.value = cents == null ? "" : (cents / 100).toFixed(2);
    });
    els.lines.addEventListener("click", (event) => {
      if (!event.target.matches('[data-action="remove-line"]')) return;
      if (state.qr.status !== "draft") return;
      const li = event.target.closest(".qr-line");
      if (!li) return;
      const lines = state.qr.lines || [];
      if (lines.length <= 1) {
        alert("A quote request needs at least one line. Cancel the RFQ instead of emptying it.");
        return;
      }
      const idx = lines.findIndex((line) => line.id === li.dataset.lineId);
      if (idx === -1) return;
      lines.splice(idx, 1);
      renderLines();
      scheduleSave(true); // flush immediately — removals shouldn't sit in a debounce window
    });

    els.sendBtn.addEventListener("click", () => openSendModal({ mode: "send" }));
    els.resendBtn.addEventListener("click", () => openSendModal({ mode: "resend" }));
    els.sendCancel.addEventListener("click", closeSendModal);
    els.sendModal.addEventListener("click", (event) => {
      if (event.target === els.sendModal) closeSendModal();
    });
    els.sendConfirm.addEventListener("click", confirmSend);

    els.applyBtn.addEventListener("click", async () => {
      // Drain EVERYTHING before reviewing — apply works off the SERVER's
      // stored prices, so the review has to show what's persisted, not
      // what's half-typed or mid-flight. A single flushSave() isn't enough:
      // an in-flight PATCH makes it reschedule rather than send, so loop
      // until no flight, no timer, and no dirty entries remain. Bounded —
      // each pass either awaits a settling flight or sends the dirty map.
      for (let guard = 0; guard < 20; guard++) {
        if (state.savePromise) await state.savePromise;
        if (state.pendingError) return; // savebar is already showing the failure
        if (!state.saveTimer && !Object.keys(state.pendingQuotes).length && !state.saving) break;
        await flushSave();
      }
      if (state.pendingError) return;
      if (Object.keys(state.pendingQuotes).length) return; // still dirty after the guard cap — don't review stale data
      if (state.qr.status !== "quoted") return; // flush may have cleared the last price (quoted→sent)
      openApplyModal();
    });
    els.applyCancel.addEventListener("click", closeApplyModal);
    els.applyModal.addEventListener("click", (event) => {
      if (event.target === els.applyModal) closeApplyModal();
    });
    els.applyConfirm.addEventListener("click", confirmApply);

    els.cancelBtn.addEventListener("click", cancelQr);

    window.addEventListener("beforeunload", () => {
      if (!state.qr) return;
      const quoteMode = canEnterQuotes();
      if (state.qr.status !== "draft" && !quoteMode) return;
      // Drafts: anything still debouncing or errored. Quote grid: any
      // dirty price entry (buildSavePayload sends exactly those).
      if (quoteMode && !Object.keys(state.pendingQuotes).length) return;
      if (!quoteMode && !state.saveTimer && !state.pendingError) return;
      try {
        fetch(`/api/quote-requests/${encodeURIComponent(state.qrId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildSavePayload()),
          keepalive: true
        });
      } catch {}
    });
  }

  wire();
  boot();
})();
