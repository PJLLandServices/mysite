// Material List builder — Phase 1.
// Mobile-first builder. Loads the list + the parts catalog, lets the
// user search/browse/add/edit/remove line items with auto-save (1.2s
// debounce). All UI state derives from `state.list` + `state.catalog`;
// the only side-channel is the dirty/saving flag for the save bar.

(function () {
  // ---- DOM handles ---------------------------------------------------
  const els = {
    loading: document.getElementById("mlbLoading"),
    error: document.getElementById("mlbError"),
    page: document.getElementById("mlbPage"),
    id: document.getElementById("mlbId"),
    status: document.getElementById("mlbStatus"),
    name: document.getElementById("mlbName"),
    customerName: document.getElementById("mlbCustomerName"),
    customerEmail: document.getElementById("mlbCustomerEmail"),
    address: document.getElementById("mlbAddress"),
    notes: document.getElementById("mlbNotes"),
    parentNote: document.getElementById("mlbParentNote"),
    parentName: document.getElementById("mlbParentName"),
    parentLink: document.getElementById("mlbParentLink"),
    attachToggle: document.getElementById("mlbAttachToggle"),
    parentPicker: document.getElementById("mlbParentPicker"),
    parentSearch: document.getElementById("mlbParentSearch"),
    parentResults: document.getElementById("mlbParentResults"),
    copySection: document.getElementById("mlbCopySection"),
    copySearch: document.getElementById("mlbCopySearch"),
    copyResults: document.getElementById("mlbCopyResults"),
    lines: document.getElementById("mlbLines"),
    linesEmpty: document.getElementById("mlbLinesEmpty"),
    lineCount: document.getElementById("mlbLineCount"),
    search: document.getElementById("mlbSearch"),
    searchHint: document.getElementById("mlbSearchHint"),
    searchResults: document.getElementById("mlbSearchResults"),
    catalogTree: document.getElementById("mlbCatalogTree"),
    archiveButton: document.getElementById("mlbArchiveButton"),
    deleteButton: document.getElementById("mlbDeleteButton"),
    generatePosButton: document.getElementById("mlbGeneratePosButton"),
    posModal: document.getElementById("mlbPosModal"),
    posPlan: document.getElementById("mlbPosPlan"),
    posModeOne: document.getElementById("mlbPosModeOne"),
    posModeSplit: document.getElementById("mlbPosModeSplit"),
    posSupplier: document.getElementById("mlbPosSupplier"),
    posError: document.getElementById("mlbPosError"),
    posConfirm: document.getElementById("mlbPosConfirm"),
    posCancel: document.getElementById("mlbPosCancel"),
    requestRfqButton: document.getElementById("mlbRequestRfqButton"),
    compareButton: document.getElementById("mlbCompareButton"),
    compareModal: document.getElementById("mlbCompareModal"),
    comparePlan: document.getElementById("mlbComparePlan"),
    compareError: document.getElementById("mlbCompareError"),
    compareCancel: document.getElementById("mlbCompareCancel"),
    compareApply: document.getElementById("mlbCompareApply"),
    rfqModeShop: document.getElementById("mlbRfqModeShop"),
    rfqModeAssigned: document.getElementById("mlbRfqModeAssigned"),
    rfqModal: document.getElementById("mlbRfqModal"),
    rfqPlan: document.getElementById("mlbRfqPlan"),
    rfqError: document.getElementById("mlbRfqError"),
    rfqConfirm: document.getElementById("mlbRfqConfirm"),
    rfqCancel: document.getElementById("mlbRfqCancel"),
    savebar: document.getElementById("mlbSavebar"),
    saveNeed: document.getElementById("mlbSaveNeed"),
    saveHave: document.getElementById("mlbSaveHave"),
    saveTotal: document.getElementById("mlbSaveTotal"),
    saveState: document.getElementById("mlbSaveState")
  };

  // ---- State ---------------------------------------------------------
  const STATUS_LABELS = {
    draft: "Draft",
    in_progress: "In progress",
    complete: "Complete",
    archived: "Archived"
  };

  const state = {
    listId: null,
    list: null,
    catalog: null,           // { categories, parts: { sku: {...} } }
    saveTimer: null,
    saving: false,
    lastSavedAt: null,
    pendingError: null,

    // Parent-picker state. Cache fetched index per type so re-opening the
    // picker doesn't re-fetch unnecessarily. `pickerType` is the currently
    // selected tab (project / work_order / quote / "" for detach).
    pickerType: null,
    parentCache: { project: null, work_order: null, quote: null },

    // Copy-from-past state. Cache the lists index after first open.
    copyCache: null
  };

  const PARENT_TYPE_LABELS = {
    project: "Project",
    work_order: "Work order",
    quote: "Quote"
  };
  const PARENT_TYPE_ENDPOINTS = {
    project: "/api/projects?includeArchived=1",
    work_order: "/api/work-orders",
    quote: "/api/admin/quote-folder"
  };
  const PARENT_TYPE_COLLECTION_KEY = {
    project: "projects",
    work_order: "workOrders",
    quote: "quotes"
  };
  const PARENT_TYPE_HREF_PATH = {
    project: "/admin/project/",
    work_order: "/admin/work-order/",
    quote: "/admin/quote-folder"
  };

  // ---- Utility -------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function fmtCents(cents) {
    return "$" + ((Number(cents) || 0) / 100).toFixed(2);
  }
  // 12 hr ago, 3 min ago, just now — small relative-time renderer for the
  // "Saved · Xs ago" indicator. Sub-minute resolution is fine for save UX.
  function relTime(iso) {
    if (!iso) return "";
    const diffMs = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diffMs)) return "";
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 5) return "just now";
    if (seconds < 60) return seconds + "s ago";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + "h ago";
    return new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric" });
  }

  function getListIdFromUrl() {
    const m = location.pathname.match(/^\/admin\/material-list\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function partFor(sku) {
    if (!state.catalog || !state.catalog.parts) return null;
    return state.catalog.parts[sku] || null;
  }

  // Resolve a line's per-unit price, in cents. Byte-for-byte mirror of
  // resolveLineUnitPriceCents in server/lib/material-lists.js (the builder
  // can't require() server code, so the logic is duplicated — keep the two
  // in sync). Frozen (line.frozenPriceCents, stamped when the line's PO was
  // sent) wins; else live from the catalog; else null = price unavailable
  // (the SKU was deleted from the catalog). No manual-line branch — ML lines
  // are always catalog SKUs.
  function resolveLineUnitPriceCents(line) {
    // null/undefined = not locked; guard before Number() (Number(null) === 0).
    const rawFrozen = line == null ? null : line.frozenPriceCents;
    const frozen = Number(rawFrozen);
    if (rawFrozen != null && Number.isFinite(frozen) && frozen >= 0) return Math.floor(frozen);
    const part = partFor(line && line.sku);
    if (part && Number.isFinite(Number(part.priceCents))) return Math.max(0, Math.floor(Number(part.priceCents)));
    return null;
  }

  // ---- Bootstrapping -------------------------------------------------
  async function boot() {
    state.listId = getListIdFromUrl();
    if (!state.listId) {
      showError("No list id in URL.");
      return;
    }
    try {
      // Load catalog + list in parallel — the catalog is used by every
      // render path so blocking on it is fine.
      const [catalog, listRes] = await Promise.all([
        fetchCatalog(),
        fetch(`/api/material-lists/${encodeURIComponent(state.listId)}`, { cache: "no-store" }).then((r) => r.json())
      ]);
      state.catalog = catalog;
      if (!listRes || !listRes.ok || !listRes.list) {
        showError((listRes && listRes.errors && listRes.errors[0]) || "Couldn't load this material list.");
        return;
      }
      state.list = listRes.list;
      els.loading.hidden = true;
      els.page.hidden = false;
      els.savebar.hidden = false;
      renderAll();
      setSaveState("saved", state.list.updatedAt);
    } catch (err) {
      showError(err.message || "Couldn't load this material list.");
    }
  }

  function showError(message) {
    els.loading.hidden = true;
    els.error.hidden = false;
    els.error.textContent = message;
  }

  async function fetchCatalog() {
    // no-store, NOT force-cache. The catalog must reflect the latest
    // parts.json prices on every (re)load: a "need" line resolves its price
    // live from here, so a catalog edit has to show up when the builder is
    // reloaded. force-cache returned a STALE /api/parts (the route sets
    // Cache-Control: max-age=300) — even after the 5 min window it kept
    // serving the cached copy — which is exactly the stale-price bug. This
    // page is not under a service worker, so there is no offline cache to
    // preserve. Matches the work-order build page (also fetches no-store).
    const r = await fetch("/api/parts", { cache: "no-store" });
    const data = await r.json();
    if (!data || !data.ok) throw new Error("Couldn't load parts catalog.");
    return {
      categories: Array.isArray(data.categories) ? data.categories : [],
      parts: data.parts || {}
    };
  }

  // ---- Render --------------------------------------------------------
  function renderAll() {
    renderHeader();
    renderLines();
    renderCatalogTree();
    renderSearchResults();
    renderSavebar();
  }

  function renderHeader() {
    els.id.textContent = state.list.id || "";
    els.status.className = `ml-status ml-status--${state.list.status}`;
    els.status.textContent = STATUS_LABELS[state.list.status] || state.list.status;
    if (document.activeElement !== els.name) els.name.value = state.list.name || "";
    if (document.activeElement !== els.customerName) els.customerName.value = state.list.customerName || "";
    if (document.activeElement !== els.customerEmail) els.customerEmail.value = state.list.customerEmail || "";
    if (document.activeElement !== els.address) els.address.value = state.list.address || "";
    if (document.activeElement !== els.notes) els.notes.value = state.list.notes || "";

    // Legacy parentNote — Phase 2 promotes this to a full bar with a
    // change button. Keep the element hidden but updated for any older
    // page state that still references it.
    if (els.parentNote) els.parentNote.hidden = true;

    // Parent attachment bar — populated whether or not a parent is set.
    if (state.list.parentType && state.list.parentId) {
      const label = PARENT_TYPE_LABELS[state.list.parentType] || state.list.parentType;
      els.parentName.textContent = `${label} · ${state.list.parentId}`;
      const hrefPath = PARENT_TYPE_HREF_PATH[state.list.parentType];
      if (hrefPath) {
        // Quote folder is the index for quote (no per-quote detail page),
        // so the link goes there rather than to a per-id URL that doesn't
        // exist. Project / WO link to their own detail pages.
        const target = state.list.parentType === "quote"
          ? hrefPath
          : hrefPath + encodeURIComponent(state.list.parentId);
        els.parentLink.href = target;
        els.parentLink.hidden = false;
      } else {
        els.parentLink.hidden = true;
      }
    } else {
      els.parentName.textContent = "Standalone";
      els.parentLink.hidden = true;
    }

    els.archiveButton.textContent = state.list.status === "archived" ? "Restore from archive" : "Archive list";
  }

  function renderLines() {
    const lines = Array.isArray(state.list.lineItems) ? state.list.lineItems : [];
    els.lineCount.textContent = lines.length === 1 ? "1 line" : `${lines.length} lines`;
    if (!lines.length) {
      els.linesEmpty.hidden = false;
      els.lines.innerHTML = "";
      return;
    }
    els.linesEmpty.hidden = true;
    els.lines.innerHTML = lines.map((line, idx) => renderLine(line, idx)).join("");
  }

  function renderLine(line, idx) {
    const part = partFor(line.sku);
    const desc = part ? (part.description || part.sku) : `Unknown SKU: ${line.sku}`;
    const sizeBadge = part && part.size ? `<span>${escapeHtml(part.size)}</span>` : "";
    const unitCents = resolveLineUnitPriceCents(line);     // integer cents | null
    const priceUnavailable = unitCents == null;
    const lineTotal = priceUnavailable ? null : unitCents * (Number(line.qty) || 0);
    const unit = part ? (part.unit || "each") : "—";
    const isFrozen = line.frozenPriceCents != null && Number.isFinite(Number(line.frozenPriceCents));
    // Price cell. Locked lines show a "locked" hint so that an unchanged
    // price after a catalog edit reads as intentional (snapshotted to a PO),
    // not as the old stale-price bug. A deleted SKU with no lock shows an
    // explicit "price unavailable" rather than a misleading $0.00.
    const priceCell = priceUnavailable
      ? `<span class="mlb-line-unavailable">price unavailable</span>`
      : `<span>${fmtCents(unitCents)} / ${escapeHtml(unit)}</span>${isFrozen ? ` <span class="mlb-line-locked" title="Price locked to ${escapeHtml(line.poId || "a purchase order")} — edit the PO to change it">locked</span>` : ""}`;
    const stateClass = part ? `is-${line.status}` : "is-unknown";
    const statusLabel = line.status === "ordered"
      ? `Ordered${line.poId ? " · " + escapeHtml(line.poId) : ""}`
      : (line.status === "have" ? "Have" : "Need");
    const statusDisabled = line.status === "ordered" ? "disabled" : "";
    return `
      <li class="mlb-line ${stateClass}" data-line-id="${escapeHtml(line.id)}">
        <div class="mlb-line-info">
          <div class="mlb-line-desc">${escapeHtml(desc)}</div>
          <div class="mlb-line-meta">
            <span class="mlb-line-sku">${escapeHtml(line.sku)}</span>
            ${sizeBadge}
            ${priceCell}
          </div>
        </div>
        <div class="mlb-line-controls">
          <div class="mlb-qty">
            <button type="button" data-action="dec" aria-label="Decrease quantity">−</button>
            <input type="number" inputmode="numeric" min="1" max="9999" value="${Number(line.qty) || 1}" data-action="qty" aria-label="Quantity">
            <button type="button" data-action="inc" aria-label="Increase quantity">+</button>
          </div>
          <span class="mlb-line-total">${priceUnavailable ? "—" : fmtCents(lineTotal)}</span>
          <button type="button" class="mlb-line-status-btn" data-action="status" ${statusDisabled} aria-label="Status">${escapeHtml(statusLabel)}</button>
          <button type="button" class="mlb-line-remove" data-action="remove" aria-label="Remove">×</button>
        </div>
        <textarea class="mlb-line-notes" data-action="notes" rows="1" maxlength="500" placeholder="Notes (optional)">${escapeHtml(line.notes || "")}</textarea>
      </li>
    `;
  }

  function renderCatalogTree() {
    if (!state.catalog) return;
    const cats = state.catalog.categories || [];
    const partsByCat = new Map();
    for (const part of Object.values(state.catalog.parts || {})) {
      if (!part || !part.sku) continue;
      const key = part.category || "other";
      if (!partsByCat.has(key)) partsByCat.set(key, []);
      partsByCat.get(key).push(part);
    }
    // Sort within each category by subcategory + numeric size for predictable order.
    function sizeRank(s) {
      const m = String(s || "").match(/[\d.]+/);
      return m ? parseFloat(m[0]) : 999;
    }
    for (const list of partsByCat.values()) {
      list.sort((a, b) => (a.subcategory || "").localeCompare(b.subcategory || "") || sizeRank(a.size) - sizeRank(b.size));
    }
    const inListSkus = new Set((state.list.lineItems || []).map((l) => l.sku));
    els.catalogTree.innerHTML = cats.map((cat) => {
      const items = partsByCat.get(cat.key) || [];
      if (!items.length) return "";
      const inListCount = items.filter((p) => inListSkus.has(p.sku)).length;
      return `
        <details class="mlb-browse-cat">
          <summary>
            ${escapeHtml(cat.label)}
            <span class="mlb-browse-cat-meta">${items.length}${inListCount ? ` · ${inListCount} in list` : ""}</span>
          </summary>
          <div class="mlb-browse-list">
            ${items.map((p) => renderResult(p, inListSkus.has(p.sku))).join("")}
          </div>
        </details>
      `;
    }).join("");
  }

  // ---- Part photos (P-PJL-35) -----------------------------------------
  // The server decides whether a photo may show (lib/part-photos.js,
  // photoStateFor) and sends `photo` only when it is verified. This code
  // never second-guesses that: no photo → the explicit "No photo" tile,
  // never a stand-in image. The photo is identity, not decoration.
  const NO_PHOTO_TITLE = {
    none: "No verified photo yet",
    tbd: "No verified photo yet",
    changed: "No verified photo yet",
    not_confident: "No reliable photo found"
  };
  const NO_PHOTO_REASON = {
    none: "This part hasn't been given a verified photo yet.",
    tbd: "A possible photo is waiting on the review screen. It stays hidden here until it's approved.",
    changed: "This part's number or description changed after its photo was matched, so the photo is hidden until it's reconfirmed.",
    not_confident: "No photo could be verified for this exact part, so none is shown rather than a guess."
  };
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_NO_PHOTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h3l2-2.5h6L17 7h3v11.5H4z"/><circle cx="12" cy="12.5" r="3.5"/><path d="M3 3l18 18"/></svg>';

  function hasVerifiedPhoto(part) {
    return !!(part && part.photoState === "verified" && part.photo && part.photo.thumb);
  }
  function noPhotoState(part) {
    const s = part && part.photoState;
    return NO_PHOTO_TITLE[s] ? s : "none";
  }
  function renderPartThumb(part) {
    const desc = escapeHtml(part.description || part.sku);
    if (hasVerifiedPhoto(part)) {
      return `<button type="button" class="mlb-thumb is-verified" data-action="photo" aria-label="View larger photo of ${desc}" title="Verified photo">
          <img src="${escapeHtml(part.photo.thumb)}"${part.photo.thumb2x ? ` srcset="${escapeHtml(part.photo.thumb)} 1x, ${escapeHtml(part.photo.thumb2x)} 2x"` : ""} alt="" width="64" height="64" loading="lazy" decoding="async">
          <span class="mlb-thumb-badge">${ICON_CHECK}</span>
        </button>`;
    }
    const title = NO_PHOTO_TITLE[noPhotoState(part)];
    return `<button type="button" class="mlb-thumb is-nophoto" data-action="photo" aria-label="${title} for ${desc}. Show why" title="${title}">
        <span class="mlb-noph">${ICON_NO_PHOTO}<span>No photo</span></span>
      </button>`;
  }

  function renderResult(part, isInList) {
    const sizeBadge = part.size ? `<span class="crm-parts-size">${escapeHtml(part.size)}</span>` : "";
    const noReliable = part.photoState === "not_confident" ? ` &middot; <span class="mlb-noreli">No reliable photo</span>` : "";
    return `
      <div class="mlb-result" data-sku="${escapeHtml(part.sku)}">
        ${renderPartThumb(part)}
        <div class="mlb-result-info">
          <div class="mlb-result-desc">${sizeBadge} ${escapeHtml(part.description || part.sku)}</div>
          <div class="mlb-result-meta">
            <span class="mlb-line-sku">${escapeHtml(part.sku)}</span>
            &middot; ${fmtCents(part.priceCents)} / ${escapeHtml(part.unit || "each")}${noReliable}
          </div>
        </div>
        <button type="button" class="mlb-result-add ${isInList ? "is-added" : ""}" data-action="add" aria-label="Add ${escapeHtml(part.sku)}">${isInList ? "+1" : "Add"}</button>
      </div>
    `;
  }

  // ---- Photo viewer ----------------------------------------------------
  // Desktop: a centred dialog. Phone (≤640px): a bottom sheet with a drag
  // handle. Closes on ×, Esc, a click outside, a swipe down, or the
  // browser/phone Back button (the viewer pushes a history entry). It
  // shows the photo and who verified it; it has no Add button, so looking
  // at a part can never add it.
  let viewer = null;
  function fmtDay(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function trustHtml(part) {
    if (!hasVerifiedPhoto(part)) {
      const s = noPhotoState(part);
      return `<div class="mlb-pv-trust is-none">${ICON_NO_PHOTO}<div><b>${NO_PHOTO_TITLE[s]}</b>${escapeHtml(NO_PHOTO_REASON[s])}<br>You can still add this part. Pick it by part #.</div></div>`;
    }
    const p = part.photo;
    const who = p.approvedBy ? escapeHtml(p.approvedBy) : "staff";
    const when = fmtDay(p.approvedAt);
    let line;
    if (p.method === "url") line = `From ${escapeHtml(p.sourceDomain || "the web")}, approved by ${who}${when ? ` on ${when}` : ""}.`;
    else if (p.method === "upload") line = `Photo set by ${who}${when ? ` on ${when}` : ""}.`;
    else line = `Passed the automated photo checks${when ? ` on ${when}` : ""}.`;
    return `<div class="mlb-pv-trust is-verified"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/></svg><div><b>Verified photo</b>${line}</div></div>`;
  }
  function sharedHtml(part) {
    const shared = (hasVerifiedPhoto(part) && part.photo.sharedWith) || [];
    if (!shared.length) return "";
    const items = shared.map((sku) => {
      const other = state.catalog && state.catalog.parts[sku];
      return `<li><span class="mlb-line-sku">${escapeHtml(sku)}</span> ${escapeHtml(other ? other.description : "")}</li>`;
    }).join("");
    return `<div class="mlb-pv-shared"><h3>Same fitting, same photo</h3><ul>${items}</ul></div>`;
  }
  function openPhotoViewer(part, trigger) {
    closePhotoViewer(true);
    const verified = hasVerifiedPhoto(part);
    const desc = part.description || part.sku;
    const sizeBadge = part.size ? `<span class="crm-parts-size">${escapeHtml(part.size)}</span> ` : "";
    const stage = verified
      ? `<div class="mlb-pv-stage"><img src="${escapeHtml(part.photo.large)}" srcset="${escapeHtml(part.photo.largeMobile)} 480w, ${escapeHtml(part.photo.large)} 1200w" sizes="(max-width: 640px) 100vw, 720px" alt="${escapeHtml(desc)}"></div>`
      : `<div class="mlb-pv-stage is-empty"><span class="mlb-noph mlb-noph--big">${ICON_NO_PHOTO}<span>No photo</span></span></div>`;
    const overlay = document.createElement("div");
    overlay.className = "mlb-pv";
    overlay.innerHTML = `
      <div class="mlb-pv-dlg" role="dialog" aria-modal="true" aria-label="${escapeHtml((verified ? "Photo of " : "No photo for ") + desc)}">
        <div class="mlb-pv-handle" aria-hidden="true"></div>
        <div class="mlb-pv-head">
          <div class="mlb-pv-title">
            <h2>${sizeBadge}${escapeHtml(desc)}</h2>
            <p><span class="mlb-line-sku">${escapeHtml(part.sku)}</span>${part.manufacturer ? ` &middot; ${escapeHtml(part.manufacturer)}` : ""}</p>
          </div>
          <button type="button" class="mlb-pv-close" data-pv="close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        ${stage}
        ${trustHtml(part)}
        ${sharedHtml(part)}
        <p class="mlb-pv-manage"><a href="/admin/part-photos?sku=${encodeURIComponent(part.sku)}">${verified ? "Manage this photo" : "Set a photo for this part"}</a></p>
      </div>`;
    document.body.appendChild(overlay);
    const dlg = overlay.querySelector(".mlb-pv-dlg");
    const img = overlay.querySelector(".mlb-pv-stage img");
    if (img) img.addEventListener("error", () => {
      img.parentElement.classList.add("is-empty");
      img.outerHTML = `<span class="mlb-noph mlb-noph--big">${ICON_NO_PHOTO}<span>Photo unavailable</span></span>`;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest("[data-pv='close']")) closePhotoViewer();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closePhotoViewer(); return; }
      if (e.key !== "Tab") return;
      const focusables = [...dlg.querySelectorAll("button, a[href]")];
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    enableSheetSwipe(dlg);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    viewer = { overlay, trigger, prevOverflow, pushed: false };
    try { history.pushState({ mlbPhotoViewer: true }, ""); viewer.pushed = true; } catch (_) { /* ignore */ }
    overlay.querySelector(".mlb-pv-close").focus({ preventScroll: true });
  }
  function closePhotoViewer(fromPopOrReplace) {
    if (!viewer) return;
    const v = viewer;
    viewer = null;
    v.overlay.remove();
    document.body.style.overflow = v.prevOverflow;
    // Closed by ×/Esc/outside/swipe: undo our history entry so Back still
    // means "leave this page" afterwards.
    if (v.pushed && !fromPopOrReplace) history.back();
    if (!fromPopOrReplace && v.trigger && v.trigger.isConnected) v.trigger.focus({ preventScroll: true });
  }
  window.addEventListener("popstate", () => {
    if (!viewer) return;
    const trigger = viewer.trigger;
    closePhotoViewer(true);
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  });
  function enableSheetSwipe(dlg) {
    const grips = [dlg.querySelector(".mlb-pv-handle"), dlg.querySelector(".mlb-pv-head")];
    let y0 = null, dy = 0;
    grips.forEach((el) => {
      el.addEventListener("pointerdown", (e) => {
        if (window.innerWidth > 640 || e.target.closest("button, a")) return;
        y0 = e.clientY; dy = 0; dlg.style.transition = "none";
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      });
      el.addEventListener("pointermove", (e) => {
        if (y0 == null) return;
        dy = Math.max(0, e.clientY - y0);
        dlg.style.transform = `translateY(${dy}px)`;
      });
      const end = () => {
        if (y0 == null) return;
        y0 = null; dlg.style.transition = "transform .18s ease-out";
        if (dy > 90) closePhotoViewer(); else dlg.style.transform = "";
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
  }

  function renderSearchResults() {
    const q = els.search.value.trim().toLowerCase();
    if (!q) {
      els.searchResults.innerHTML = "";
      els.searchHint.hidden = true;
      return;
    }
    const parts = Object.values(state.catalog.parts || {});
    const matches = parts.filter((p) => {
      const haystack = [
        p.sku, p.partNumber, p.description, p.category, p.subcategory, p.size
      ].map((v) => String(v || "").toLowerCase()).join(" ");
      return haystack.includes(q);
    });
    // Cap at 30 results — keeps the DOM small and the user typing toward
    // a more specific query rather than scrolling.
    const capped = matches.slice(0, 30);
    const inListSkus = new Set((state.list.lineItems || []).map((l) => l.sku));
    if (!capped.length) {
      els.searchHint.hidden = false;
      els.searchHint.textContent = "No matching parts.";
      els.searchResults.innerHTML = "";
      return;
    }
    els.searchHint.hidden = false;
    els.searchHint.textContent = matches.length > capped.length
      ? `Showing first ${capped.length} of ${matches.length} matches — keep typing to narrow.`
      : `${matches.length} match${matches.length === 1 ? "" : "es"}.`;
    els.searchResults.innerHTML = capped.map((p) => renderResult(p, inListSkus.has(p.sku))).join("");
  }

  function renderSavebar() {
    const totals = computeTotals(state.list);
    els.saveNeed.textContent = totals.needCount ? `${totals.needCount} need · ${fmtCents(totals.needCents)}` : "0 need";
    els.saveHave.textContent = totals.haveCount ? `${totals.haveCount} have · ${fmtCents(totals.haveCents)}` : "0 have";
    els.saveTotal.textContent = fmtCents(totals.grandCents);
  }

  // Local totals computation — same logic + same resolver as server-side
  // computeTotals (frozen-then-live). Re-run on every render so the savebar
  // stays in sync with the in-memory list, not just the last server
  // snapshot. A price-unavailable line (deleted SKU, not locked) contributes
  // 0, matching the server.
  function computeTotals(list) {
    const out = {
      lineCount: 0, needCount: 0, orderedCount: 0, haveCount: 0,
      needCents: 0, haveCents: 0, orderedCents: 0, grandCents: 0
    };
    for (const line of list.lineItems || []) {
      out.lineCount++;
      const unit = resolveLineUnitPriceCents(line);
      const cents = (unit == null ? 0 : unit) * (Number(line.qty) || 0);
      out.grandCents += cents;
      if (line.status === "need")    { out.needCount++;    out.needCents    += cents; }
      if (line.status === "ordered") { out.orderedCount++; out.orderedCents += cents; }
      if (line.status === "have")    { out.haveCount++;    out.haveCents    += cents; }
    }
    return out;
  }

  // ---- Save bar state -----------------------------------------------
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

  // Refresh "saved · Ns ago" once a second so the timestamp doesn't go
  // stale when the user is reading the page without making changes.
  setInterval(() => {
    if (els.saveState.classList.contains("is-saved") && state.lastSavedAt) {
      els.saveState.textContent = `Saved · ${relTime(state.lastSavedAt)}`;
    }
  }, 5000);

  // ---- Mutation + save ----------------------------------------------
  function scheduleSave(immediate = false) {
    setSaveState("dirty");
    if (state.saveTimer) clearTimeout(state.saveTimer);
    if (immediate) {
      flushSave();
      return;
    }
    state.saveTimer = setTimeout(flushSave, 1200);
  }

  async function flushSave() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    if (state.saving) {
      // Already in flight — schedule another flush right after this one
      // completes via the finally branch.
      state.saveTimer = setTimeout(flushSave, 200);
      return;
    }
    state.saving = true;
    setSaveState("saving");
    state.pendingError = null;
    try {
      // Send the editable subset only — server ignores unknown keys.
      const payload = {
        name: state.list.name,
        customerName: state.list.customerName,
        customerEmail: state.list.customerEmail,
        address: state.list.address,
        notes: state.list.notes,
        lineItems: state.list.lineItems
      };
      const r = await fetch(`/api/material-lists/${encodeURIComponent(state.listId)}`, {
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
      // Server is authoritative — replace local state with what came back
      // (server fills new line ids, re-derives status, updates timestamps).
      state.list = data.list;
      // Don't re-render fields the user is currently editing — preserves
      // cursor position and avoids "input flicker." renderHeader checks
      // document.activeElement for that purpose.
      renderAll();
      setSaveState("saved", state.list.updatedAt);
    } catch (err) {
      state.pendingError = err.message || "Save failed";
      setSaveState("error");
    } finally {
      state.saving = false;
    }
  }

  // ---- Mutation helpers (only mutate state.list, then scheduleSave) -
  function addOrIncrementLine(sku) {
    if (!state.catalog.parts[sku]) return; // silent ignore — unknown sku
    const lines = state.list.lineItems = Array.isArray(state.list.lineItems) ? state.list.lineItems : [];
    const existing = lines.find((l) => l.sku === sku && l.status !== "ordered");
    // If a line for this SKU exists AND isn't already locked-on-PO, bump
    // qty rather than create a duplicate. If the only line is "ordered",
    // create a new "need" line so the user can plan additional purchase.
    if (existing) {
      existing.qty = Math.min((Number(existing.qty) || 0) + 1, 9999);
    } else {
      lines.push({
        // Server stamps a real id on save — the temp prefix lets the
        // remove-by-id flow work between add and first save.
        id: "tmp_" + Math.random().toString(36).slice(2, 10),
        sku,
        qty: 1,
        status: "need",
        poId: null,
        notes: ""
      });
    }
    renderAll();
    scheduleSave();
  }

  function setLineQty(lineId, qty) {
    const line = state.list.lineItems.find((l) => l.id === lineId);
    if (!line) return;
    const safe = Math.max(1, Math.min(Math.floor(Number(qty) || 1), 9999));
    if (line.qty === safe) return;
    line.qty = safe;
    renderAll();
    scheduleSave();
  }

  function cycleLineStatus(lineId) {
    const line = state.list.lineItems.find((l) => l.id === lineId);
    if (!line) return;
    if (line.status === "ordered") return; // locked — set by Phase 3 PO flow
    line.status = line.status === "need" ? "have" : "need";
    renderAll();
    scheduleSave();
  }

  function setLineNotes(lineId, notes) {
    const line = state.list.lineItems.find((l) => l.id === lineId);
    if (!line) return;
    if (line.notes === notes) return;
    line.notes = notes;
    // Don't re-render — would steal focus from the textarea. The next
    // server round-trip will pick it up.
    scheduleSave();
  }

  async function removeLine(lineId) {
    const line = state.list.lineItems.find((l) => l.id === lineId);
    if (!line) return;
    if (line.status === "ordered") {
      await pjlDialog.alert("This line is on a sent purchase order. Cancel the PO before removing the line.", { title: "Line locked", icon: "warning" });
      return;
    }
    if (!(await pjlDialog.confirm("Remove this line?", { title: "Remove line", icon: "delete", destructive: true, confirmLabel: "Remove" }))) return;
    state.list.lineItems = state.list.lineItems.filter((l) => l.id !== lineId);
    renderAll();
    scheduleSave();
  }

  // ---- Parent picker -------------------------------------------------
  function openPickerToggle() {
    const willOpen = els.parentPicker.hidden;
    els.parentPicker.hidden = !willOpen;
    if (willOpen) {
      // Default to the type the list is currently attached to (so the
      // user lands looking at the relevant index). Standalone -> project.
      pickPickerTab(state.list.parentType || "project");
    }
  }

  function pickPickerTab(parentType) {
    state.pickerType = parentType || "";
    // Update tab visual state
    els.parentPicker.querySelectorAll("[data-parent-type]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.parentType === state.pickerType);
    });
    if (!state.pickerType) {
      // Detach (standalone). Show a confirm row instead of a picker.
      els.parentSearch.hidden = true;
      els.parentResults.innerHTML = (state.list.parentType && state.list.parentId)
        ? `<div class="mlb-parent-results-empty">
             <p style="margin:0 0 10px">Detach this list from its current parent (<strong>${escapeHtml(state.list.parentType.replace("_"," "))} ${escapeHtml(state.list.parentId)}</strong>)?</p>
             <button type="button" class="mlb-result-add" id="mlbDetachConfirm">Detach</button>
           </div>`
        : `<div class="mlb-parent-results-empty">This list is already standalone.</div>`;
      return;
    }
    els.parentSearch.hidden = false;
    els.parentSearch.value = "";
    els.parentResults.innerHTML = `<div class="mlb-parent-results-empty">Loading…</div>`;
    loadParentIndex(state.pickerType).then(() => renderParentResults()).catch((err) => {
      els.parentResults.innerHTML = `<div class="mlb-parent-results-empty">Couldn't load: ${escapeHtml(err.message || "unknown error")}</div>`;
    });
  }

  async function loadParentIndex(type) {
    if (state.parentCache[type]) return state.parentCache[type];
    const r = await fetch(PARENT_TYPE_ENDPOINTS[type], { cache: "no-store" });
    const data = await r.json();
    if (!data || !data.ok) throw new Error("Couldn't load index");
    const key = PARENT_TYPE_COLLECTION_KEY[type];
    state.parentCache[type] = Array.isArray(data[key]) ? data[key] : [];
    return state.parentCache[type];
  }

  function renderParentResults() {
    const type = state.pickerType;
    if (!type) return;
    const all = state.parentCache[type] || [];
    const q = els.parentSearch.value.trim().toLowerCase();
    const filtered = q
      ? all.filter((rec) => {
          const haystack = [rec.id, rec.name, rec.customerName, rec.customerEmail, rec.address].map((v) => String(v || "").toLowerCase()).join(" ");
          return haystack.includes(q);
        })
      : all.slice(0, 30);
    if (!filtered.length) {
      els.parentResults.innerHTML = `<div class="mlb-parent-results-empty">No matches.</div>`;
      return;
    }
    const isCurrent = (rec) => state.list.parentType === type && state.list.parentId === rec.id;
    els.parentResults.innerHTML = filtered.slice(0, 30).map((rec) => {
      const name = rec.name || rec.customerName || rec.id;
      const meta = [rec.id, rec.customerName, rec.customerEmail].filter(Boolean).join(" · ");
      return `
        <button type="button" class="mlb-parent-result ${isCurrent(rec) ? "is-current" : ""}" data-parent-id="${escapeHtml(rec.id)}">
          <div class="mlb-parent-result-info">
            <div class="mlb-parent-result-name">${escapeHtml(name)}</div>
            <div class="mlb-parent-result-meta">${escapeHtml(meta)}</div>
          </div>
          <span style="font-size:12px;color:#7A7A72">${isCurrent(rec) ? "current" : "+ pick"}</span>
        </button>
      `;
    }).join("");
  }

  function attachToParent(parentType, parentId) {
    state.list.parentType = parentType || null;
    state.list.parentId = parentId || null;
    renderHeader();
    // Force-save immediately so the parent change is durable before any
    // line-item edits queue up behind it.
    scheduleSave(true);
    els.parentPicker.hidden = true;
  }

  // ---- Copy from past list ------------------------------------------
  async function loadCopyCache() {
    if (state.copyCache) return state.copyCache;
    const r = await fetch("/api/material-lists?withTotals=1&includeArchived=1", { cache: "no-store" });
    const data = await r.json();
    if (!data || !data.ok) throw new Error("Couldn't load lists");
    // Exclude this list itself — copying yourself is a no-op anyway, but
    // the UI shouldn't offer it.
    state.copyCache = (data.lists || []).filter((rec) => rec.id !== state.listId);
    return state.copyCache;
  }

  function renderCopyResults() {
    const all = state.copyCache || [];
    const q = els.copySearch.value.trim().toLowerCase();
    const filtered = q
      ? all.filter((rec) => [rec.id, rec.name, rec.customerName].map((v) => String(v || "").toLowerCase()).join(" ").includes(q))
      : all.slice(0, 20);
    if (!filtered.length) {
      els.copyResults.innerHTML = `<div class="mlb-parent-results-empty">No matches.</div>`;
      return;
    }
    els.copyResults.innerHTML = filtered.slice(0, 20).map((rec) => {
      const totals = rec.totals || {};
      const lineCount = totals.lineCount || (rec.lineItems || []).length || 0;
      const disabled = lineCount === 0;
      return `
        <div class="mlb-copy-result" data-list-id="${escapeHtml(rec.id)}">
          <div class="mlb-copy-result-info">
            <div class="mlb-copy-result-name">${escapeHtml(rec.name || "(untitled)")}</div>
            <div class="mlb-copy-result-meta">
              <span style="font-family:ui-monospace,monospace">${escapeHtml(rec.id)}</span>
              ${rec.customerName ? ` · ${escapeHtml(rec.customerName)}` : ""}
              · ${lineCount} line${lineCount === 1 ? "" : "s"}
            </div>
          </div>
          <button type="button" class="mlb-copy-result-add ${disabled ? "is-disabled" : ""}" data-action="copy" ${disabled ? "disabled" : ""}>${disabled ? "empty" : "copy"}</button>
        </div>
      `;
    }).join("");
  }

  async function copyFromList(sourceId) {
    // Fetch the full source list (the index might omit lineItems detail
    // depending on what was cached). One round-trip = safe + simple.
    const r = await fetch(`/api/material-lists/${encodeURIComponent(sourceId)}`, { cache: "no-store" });
    const data = await r.json();
    if (!data || !data.ok || !data.list) {
      await pjlDialog.alert("Couldn't load source list.", { title: "Copy failed", icon: "warning" });
      return;
    }
    const sourceLines = Array.isArray(data.list.lineItems) ? data.list.lineItems : [];
    if (!sourceLines.length) return;

    // Merge into current line items by SKU. Existing SKU -> bump qty.
    // New SKU -> append at status: need (regardless of source status —
    // copy is a planning aid, not a state import).
    const bySku = new Map();
    for (const l of state.list.lineItems || []) {
      bySku.set(l.sku, l);
    }
    let added = 0, merged = 0;
    for (const src of sourceLines) {
      if (!src.sku) continue;
      const existing = bySku.get(src.sku);
      if (existing && existing.status !== "ordered") {
        existing.qty = Math.min((Number(existing.qty) || 0) + (Number(src.qty) || 0), 9999);
        merged++;
      } else {
        const newLine = {
          id: "tmp_" + Math.random().toString(36).slice(2, 10),
          sku: src.sku,
          qty: Math.min(Number(src.qty) || 1, 9999),
          status: "need",
          poId: null,
          notes: src.notes || ""
        };
        state.list.lineItems = state.list.lineItems || [];
        state.list.lineItems.push(newLine);
        bySku.set(src.sku, newLine);
        added++;
      }
    }
    renderAll();
    scheduleSave();
    // Brief inline confirmation in the copy hint area.
    els.copyResults.innerHTML = `<div class="mlb-parent-results-empty" style="background:#DDEDD0;border-color:#B5D29A;color:#1B4D2E"><strong>Copied:</strong> ${added} added, ${merged} merged.</div>`;
  }

  // ---- Top-level field updates (debounced auto-save) ----------------
  function bindFieldInput(input, fieldName) {
    input.addEventListener("input", () => {
      state.list[fieldName] = input.value;
      scheduleSave();
    });
    input.addEventListener("blur", () => {
      // Force immediate save on blur so the user gets a definitive "Saved"
      // before they leave the field.
      if (state.saveTimer || state.pendingError) flushSave();
    });
  }

  // ---- Generate POs (plan + confirm) --------------------------------
  // Which supplier the whole order goes to, or null in split mode. The
  // <select> is filled from the plan response the first time it answers,
  // so the picker always offers real suppliers rather than a guess.
  function posForcedSupplierId() {
    if (els.posModeSplit && els.posModeSplit.checked) return null;
    return (els.posSupplier && els.posSupplier.value) || null;
  }
  function fillPosSuppliers(options, preferredId) {
    if (!els.posSupplier || !options || !options.length) return;
    const keep = els.posSupplier.value;
    if (els.posSupplier.options.length !== options.length) {
      els.posSupplier.innerHTML = options
        .map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`)
        .join("");
    }
    const want = keep || preferredId || options[0].id;
    if (want) els.posSupplier.value = want;
  }
  async function openPosModal() {
    els.posError.hidden = true;
    els.posConfirm.hidden = true;
    els.posModal.hidden = false;
    els.posPlan.innerHTML = `<p class="proj-empty">Planning…</p>`;
    try {
      const r = await fetch(`/api/material-lists/${encodeURIComponent(state.listId)}/plan-purchase-orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ supplierId: posForcedSupplierId() })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok && !data.previews) {
        els.posError.textContent = (data.errors && data.errors[0]) || `Couldn't plan (${r.status})`;
        els.posError.hidden = false;
        els.posPlan.innerHTML = "";
        return;
      }
      renderPosPlan(data);
    } catch (err) {
      els.posError.textContent = err.message || "Couldn't plan.";
      els.posError.hidden = false;
      els.posPlan.innerHTML = "";
    }
  }
  function renderPosPlan(plan) {
    const previews = plan.previews || [];
    const missing = plan.missingSupplier || [];
    // The busiest supplier in the split view is the sensible default for
    // the one-order picker — it is where most of the list already lives.
    const busiest = previews.slice().sort((a, b) => b.lineItems.length - a.lineItems.length)[0];
    fillPosSuppliers(plan.supplierOptions, plan.forcedSupplierId || (busiest && busiest.supplierId));
    let html = "";
    if (previews.length) {
      html += `<div style="margin:0 0 12px"><strong>${previews.length} purchase order${previews.length === 1 ? "" : "s"} will be created:</strong></div>`;
      html += `<ul style="list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:8px">`;
      for (const p of previews) {
        const lineCount = p.lineItems.length;
        html += `
          <li style="padding:10px 12px;border:1px solid #E8E5D7;border-radius:8px;background:#FCFBF4">
            <div style="font-weight:600;color:#1F2A22">${escapeHtml(p.supplierName)}</div>
            <div style="font-size:12px;color:#7A7A72;margin-top:2px">
              ${escapeHtml(p.supplierEmail || "(no email — add to supplier record before sending)")}
              · ${lineCount} line${lineCount === 1 ? "" : "s"}
              · ${fmtCents(p.subtotalCents)}
            </div>
          </li>
        `;
      }
      html += `</ul>`;
    }
    if (missing.length) {
      html += `
        <div style="padding:10px 12px;background:#FFF1D6;border:1px solid #E0CB8E;border-radius:8px;color:#7A5500;margin-top:8px">
          <strong>${missing.length} SKU${missing.length === 1 ? "" : "s"} blocked — no supplier assigned:</strong>
          <div style="font-family:ui-monospace,monospace;font-size:12px;margin-top:4px">${missing.map(escapeHtml).join(", ")}</div>
          <div style="margin-top:8px;font-size:12px"><a href="/admin/parts-suppliers" style="color:#7A5500;font-weight:700">→ Open Catalog assignments</a> to fix, then re-open this dialog.</div>
        </div>
      `;
    }
    const unpriced = plan.unpricedForSupplier || [];
    if (unpriced.length) {
      // Lines this supplier has never quoted: priced from the catalog,
      // which holds some other supplier's number. Worth knowing before
      // the PO total is treated as real money.
      html += `
        <div style="padding:10px 12px;background:#FFF1D6;border:1px solid #E0CB8E;border-radius:8px;color:#7A5500;margin-top:8px">
          <strong>${unpriced.length} line${unpriced.length === 1 ? "" : "s"} priced from the catalog</strong> — this supplier hasn't quoted ${unpriced.length === 1 ? "it" : "them"}, so the price shown is another supplier's.
          <div style="font-family:ui-monospace,monospace;font-size:12px;margin-top:4px">${unpriced.slice(0, 12).map(escapeHtml).join(", ")}${unpriced.length > 12 ? ", …" : ""}</div>
        </div>
      `;
    }
    if (!previews.length && !missing.length) {
      html = `<p class="proj-empty">No <em>need</em> lines on this list. Mark some lines as need, then come back.</p>`;
    }
    els.posPlan.innerHTML = html;
    els.posConfirm.hidden = !plan.canGenerate;
  }
  async function confirmGeneratePos() {
    els.posError.hidden = true;
    els.posConfirm.disabled = true;
    try {
      const r = await fetch(`/api/material-lists/${encodeURIComponent(state.listId)}/generate-purchase-orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ supplierId: posForcedSupplierId() })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.posError.textContent = (data.errors && data.errors[0]) || `Generate failed (${r.status})`;
        els.posError.hidden = false;
        return;
      }
      // Created — go to PO index where the new drafts will appear at the top.
      location.href = "/admin/purchase-orders";
    } catch (err) {
      els.posError.textContent = err.message || "Generate failed.";
      els.posError.hidden = false;
    } finally {
      els.posConfirm.disabled = false;
    }
  }

  // ---- Request Quotation (RFQ) — plan + confirm ----------------------
  // Same plan-then-confirm shape as Generate POs, but the RFQ path asks
  // suppliers for pricing without committing: it never snapshots prices
  // and never flips line status (lines stay "need").
  // Shop mode is the default: it is the one that answers "who is cheaper",
  // and it is the only one that cannot be blocked by a missing supplier
  // assignment. Switching the radio re-plans so the dialog always shows
  // what Generate will actually do.
  function rfqShopping() { return !els.rfqModeAssigned || !els.rfqModeAssigned.checked; }
  async function openRfqModal() {
    els.rfqError.hidden = true;
    els.rfqConfirm.hidden = true;
    els.rfqModal.hidden = false;
    els.rfqPlan.innerHTML = `<p class="proj-empty">Planning…</p>`;
    try {
      const q = rfqShopping() ? "?shop=all" : "";
      const r = await fetch(`/api/material-lists/${encodeURIComponent(state.listId)}/plan-quote-requests${q}`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok && !data.previews) {
        els.rfqError.textContent = (data.errors && data.errors[0]) || `Couldn't plan (${r.status})`;
        els.rfqError.hidden = false;
        els.rfqPlan.innerHTML = "";
        return;
      }
      renderRfqPlan(data);
    } catch (err) {
      els.rfqError.textContent = err.message || "Couldn't plan.";
      els.rfqError.hidden = false;
      els.rfqPlan.innerHTML = "";
    }
  }
  function renderRfqPlan(plan) {
    const previews = plan.previews || [];
    const missing = plan.missingSupplier || [];
    let html = "";
    if (previews.length) {
      const shopping = plan.mode === "shop";
      html += `<div style="margin:0 0 12px"><strong>${previews.length} quote request${previews.length === 1 ? "" : "s"} will be created${shopping ? ", each carrying the whole list" : ""}:</strong></div>`;
      html += `<ul style="list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:8px">`;
      for (const p of previews) {
        html += `
          <li style="padding:10px 12px;border:1px solid #E8E5D7;border-radius:8px;background:#FCFBF4">
            <div style="font-weight:600;color:#1F2A22">${escapeHtml(p.supplierName)}</div>
            <div style="font-size:12px;color:#7A7A72;margin-top:2px">
              ${escapeHtml(p.supplierEmail || "(no email — add to supplier record before sending)")}
              · ${p.lineCount} line${p.lineCount === 1 ? "" : "s"}
              ${p.existingDraftId ? ` · <span style="color:#1F4D7A;font-weight:600">refreshes ${escapeHtml(p.existingDraftId)}</span>` : ""}
            </div>
          </li>
        `;
      }
      html += `</ul>`;
      html += `<p style="margin:0 0 4px;font-size:12px;color:#7A7A72">Lines stay marked <strong>need</strong> — requesting a quote doesn't order anything.</p>`;
    }
    if (missing.length) {
      html += `
        <div style="padding:10px 12px;background:#FFF1D6;border:1px solid #E0CB8E;border-radius:8px;color:#7A5500;margin-top:8px">
          <strong>${missing.length} SKU${missing.length === 1 ? "" : "s"} blocked — no supplier assigned:</strong>
          <div style="font-family:ui-monospace,monospace;font-size:12px;margin-top:4px">${missing.map(escapeHtml).join(", ")}</div>
          <div style="margin-top:8px;font-size:12px">Switch to <strong>Shop the whole list</strong> above to ask everyone anyway, or <a href="/admin/parts-suppliers" style="color:#7A5500;font-weight:700">open Catalog assignments</a> to fix it.</div>
        </div>
      `;
    }
    if (plan.mode === "shop" && previews.length === 1) {
      html += `
        <div style="padding:10px 12px;background:#FFF1D6;border:1px solid #E0CB8E;border-radius:8px;color:#7A5500;margin-top:8px">
          Only one supplier is on file, so there is nothing to compare. Add a second on the Suppliers page first.
        </div>`;
    }
    if (!previews.length && !missing.length) {
      html = `<p class="proj-empty">No <em>need</em> lines on this list. Mark some lines as need, then come back.</p>`;
    }
    els.rfqPlan.innerHTML = html;
    els.rfqConfirm.hidden = !plan.canGenerate || (plan.mode === "shop" && previews.length < 2);
  }
  async function confirmGenerateRfqs() {
    els.rfqError.hidden = true;
    els.rfqConfirm.disabled = true;
    try {
      const r = await fetch(`/api/material-lists/${encodeURIComponent(state.listId)}/generate-quote-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rfqShopping() ? { shopAll: true } : {})
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.rfqError.textContent = (data.errors && data.errors[0]) || `Generate failed (${r.status})`;
        els.rfqError.hidden = false;
        return;
      }
      // Created — land on the RFQ index where the new drafts sit on top.
      location.href = "/admin/quote-requests";
    } catch (err) {
      els.rfqError.textContent = err.message || "Generate failed.";
      els.rfqError.hidden = false;
    } finally {
      els.rfqConfirm.disabled = false;
    }
  }

  // ---- Quote comparison ----------------------------------------------
  async function openCompareModal() {
    els.compareError.hidden = true;
    els.compareApply.hidden = true;
    els.compareModal.hidden = false;
    els.comparePlan.innerHTML = `<p class="proj-empty">Loading…</p>`;
    try {
      const r = await fetch(`/api/material-lists/${encodeURIComponent(state.listId)}/quote-comparison`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.compareError.textContent = (data.errors && data.errors[0]) || `Couldn't load (${r.status})`;
        els.compareError.hidden = false;
        els.comparePlan.innerHTML = "";
        return;
      }
      renderCompare(data);
    } catch (err) {
      els.compareError.textContent = err.message || "Couldn't load.";
      els.compareError.hidden = false;
      els.comparePlan.innerHTML = "";
    }
  }
  function renderCompare(data) {
    const rows = data.rows || [];
    const rfqs = data.rfqs || [];
    if (!rows.length) {
      els.comparePlan.innerHTML = `<p class="proj-empty">No prices back yet. Send the quote requests, then record each supplier's reply on its RFQ page.</p>`;
      return;
    }
    const cols = rfqs.map((r) => r.supplierId);
    const nameById = Object.fromEntries(rfqs.map((r) => [r.supplierId, r.supplierName || r.supplierId]));
    let saving = 0;
    for (const row of rows) saving += row.savingCents || 0;
    let html = `<div style="margin:0 0 10px;font-size:13px">
      ${rows.length} SKU${rows.length === 1 ? "" : "s"} quoted by ${rfqs.length} supplier${rfqs.length === 1 ? "" : "s"}.
      ${saving > 0 ? `Taking the cheapest of each saves <strong>${fmtCents(saving)}</strong> against always buying the dearest.` : ""}
    </div>`;
    html += `<div style="max-height:46vh;overflow:auto;border:1px solid #E8E5D7;border-radius:8px">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="background:#FCFBF4">
        <th style="text-align:left;padding:7px 10px">SKU</th>
        <th style="text-align:left;padding:7px 10px">Description</th>
        <th style="text-align:right;padding:7px 10px">Qty</th>
        ${cols.map((c) => `<th style="text-align:right;padding:7px 10px">${escapeHtml(nameById[c])}</th>`).join("")}
      </tr></thead><tbody>`;
    for (const row of rows) {
      const byS = Object.fromEntries(row.quotes.map((q) => [q.supplierId, q]));
      html += `<tr style="border-top:1px solid #EFEDE2">
        <td style="padding:6px 10px;font-family:ui-monospace,monospace">${escapeHtml(row.sku)}</td>
        <td style="padding:6px 10px">${escapeHtml(row.description || "")}</td>
        <td style="padding:6px 10px;text-align:right">${row.quantity}</td>`;
      for (const c of cols) {
        const q = byS[c];
        if (!q) { html += `<td style="padding:6px 10px;text-align:right;color:#B4B0A0">—</td>`; continue; }
        const win = row.cheapest && row.cheapest.supplierId === c;
        // A single quote is not a comparison, so it is never dressed up as
        // a winner — it is just the only number we have.
        const mark = win && row.comparable;
        html += `<td style="padding:6px 10px;text-align:right;${mark ? "font-weight:700;color:#1B5E20;background:#EEF6EE" : ""}">${fmtCents(q.priceCents)}${mark ? " ✓" : ""}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
    const single = rows.filter((r) => !r.comparable).length;
    if (single) {
      html += `<p style="margin:10px 0 0;font-size:12px;color:#7A5500">${single} SKU${single === 1 ? " has" : "s have"} only one price back — nothing to compare on ${single === 1 ? "it" : "those"} yet.</p>`;
    }
    els.comparePlan.innerHTML = html;
    els.compareApply.hidden = false;
  }
  async function applyCheapest() {
    els.compareError.hidden = true;
    els.compareApply.disabled = true;
    try {
      const r = await fetch(`/api/material-lists/${encodeURIComponent(state.listId)}/apply-cheapest-quotes`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.compareError.textContent = (data.errors && data.errors[0]) || `Apply failed (${r.status})`;
        els.compareError.hidden = false;
        return;
      }
      const n = (data.applied || []).length;
      els.comparePlan.innerHTML = `<p class="proj-empty">${n} catalog price${n === 1 ? "" : "s"} updated to the cheapest quote${(data.skipped || []).length ? ` · ${data.skipped.length} skipped` : ""}. Reloading the list…</p>`;
      els.compareApply.hidden = true;
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      els.compareError.textContent = err.message || "Apply failed.";
      els.compareError.hidden = false;
    } finally {
      els.compareApply.disabled = false;
    }
  }

  // ---- Event wiring --------------------------------------------------
  function wireEvents() {
    bindFieldInput(els.name, "name");
    bindFieldInput(els.customerName, "customerName");
    bindFieldInput(els.customerEmail, "customerEmail");
    bindFieldInput(els.address, "address");
    bindFieldInput(els.notes, "notes");

    // Line item delegated events
    els.lines.addEventListener("click", (event) => {
      const line = event.target.closest("[data-line-id]");
      if (!line) return;
      const action = event.target.closest("[data-action]")?.dataset.action;
      const lineId = line.dataset.lineId;
      const current = state.list.lineItems.find((l) => l.id === lineId);
      if (!current) return;
      if (action === "inc") setLineQty(lineId, (Number(current.qty) || 0) + 1);
      else if (action === "dec") setLineQty(lineId, (Number(current.qty) || 0) - 1);
      else if (action === "status") cycleLineStatus(lineId);
      else if (action === "remove") removeLine(lineId);
    });
    els.lines.addEventListener("change", (event) => {
      const line = event.target.closest("[data-line-id]");
      if (!line) return;
      const action = event.target.dataset.action;
      const lineId = line.dataset.lineId;
      if (action === "qty") setLineQty(lineId, event.target.value);
    });
    els.lines.addEventListener("input", (event) => {
      if (event.target.dataset.action !== "notes") return;
      const line = event.target.closest("[data-line-id]");
      if (!line) return;
      setLineNotes(line.dataset.lineId, event.target.value);
    });

    // Search + browse — both render .mlb-result rows; one click handler
    // serves both surfaces.
    function onAddClick(event) {
      // The photo is its own button. Opening it never adds the part —
      // adding is always the deliberate press of Add.
      const photoBtn = event.target.closest("[data-action='photo']");
      if (photoBtn) {
        const row = photoBtn.closest("[data-sku]");
        const part = row && state.catalog && state.catalog.parts[row.dataset.sku];
        if (part) openPhotoViewer(part, photoBtn);
        return;
      }
      const button = event.target.closest("[data-action='add']");
      if (!button) return;
      const result = event.target.closest("[data-sku]");
      if (!result) return;
      addOrIncrementLine(result.dataset.sku);
      // Visual feedback — temporarily flip the button to "+1".
      button.classList.add("is-added");
      button.textContent = "+1";
    }
    els.searchResults.addEventListener("click", onAddClick);
    els.catalogTree.addEventListener("click", onAddClick);
    // A verified photo that fails to load (offline, or deleted on the
    // server) becomes the "No photo" tile, never a broken image. `error`
    // doesn't bubble, so listen in the capture phase.
    function onThumbError(event) {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      const btn = img.closest(".mlb-thumb.is-verified");
      const row = btn && btn.closest("[data-sku]");
      if (!row) return;
      const part = state.catalog && state.catalog.parts[row.dataset.sku];
      btn.outerHTML = renderPartThumb({ ...(part || {}), sku: row.dataset.sku, photoState: "none", photo: null });
    }
    els.searchResults.addEventListener("error", onThumbError, true);
    els.catalogTree.addEventListener("error", onThumbError, true);

    let searchTimer = null;
    els.search.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      // 120ms debounce — keeps long-press / fast typing snappy without
      // re-rendering on every keystroke.
      searchTimer = setTimeout(() => renderSearchResults(), 120);
    });

    // Parent picker
    els.attachToggle.addEventListener("click", openPickerToggle);
    els.parentPicker.addEventListener("click", (event) => {
      const tabBtn = event.target.closest("[data-parent-type]");
      if (tabBtn) { pickPickerTab(tabBtn.dataset.parentType); return; }
      const result = event.target.closest("[data-parent-id]");
      if (result) { attachToParent(state.pickerType, result.dataset.parentId); return; }
      const detachBtn = event.target.closest("#mlbDetachConfirm");
      if (detachBtn) { attachToParent(null, null); return; }
    });
    let parentSearchTimer = null;
    els.parentSearch.addEventListener("input", () => {
      if (parentSearchTimer) clearTimeout(parentSearchTimer);
      parentSearchTimer = setTimeout(() => renderParentResults(), 120);
    });

    // Copy from past list — load on first open of <details>.
    els.copySection.addEventListener("toggle", async () => {
      if (!els.copySection.open) return;
      els.copyResults.innerHTML = `<div class="mlb-parent-results-empty">Loading…</div>`;
      try {
        await loadCopyCache();
        renderCopyResults();
      } catch (err) {
        els.copyResults.innerHTML = `<div class="mlb-parent-results-empty">Couldn't load: ${escapeHtml(err.message || "unknown error")}</div>`;
      }
    });
    let copySearchTimer = null;
    els.copySearch.addEventListener("input", () => {
      if (copySearchTimer) clearTimeout(copySearchTimer);
      copySearchTimer = setTimeout(() => renderCopyResults(), 120);
    });
    els.copyResults.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action='copy']");
      if (!btn || btn.disabled) return;
      const row = event.target.closest("[data-list-id]");
      if (row) copyFromList(row.dataset.listId);
    });

    // Footer actions
    // Generate POs — plan-then-confirm. The plan endpoint is a dry-run
    // that returns previews + missing supplier list; confirm fires the
    // generate endpoint that actually creates the draft POs.
    els.generatePosButton.addEventListener("click", openPosModal);
    els.posCancel.addEventListener("click", () => { els.posModal.hidden = true; });
    els.posModal.addEventListener("click", (event) => {
      if (event.target === els.posModal) els.posModal.hidden = true;
    });
    els.posConfirm.addEventListener("click", confirmGeneratePos);

    // Request Quotation — mirrors the PO plan/confirm wiring.
    els.requestRfqButton.addEventListener("click", openRfqModal);
    els.rfqCancel.addEventListener("click", () => { els.rfqModal.hidden = true; });
    els.compareButton.addEventListener("click", openCompareModal);
    els.compareCancel.addEventListener("click", () => { els.compareModal.hidden = true; });
    els.compareApply.addEventListener("click", applyCheapest);
    // Re-plan on mode change so the preview is never stale about what
    // Generate is about to do.
    for (const el of [els.rfqModeShop, els.rfqModeAssigned]) {
      if (el) el.addEventListener("change", openRfqModal);
    }
    // Same rule on the PO dialog: switching one-order/split, or picking a
    // different supplier, re-plans rather than leaving last mode's preview
    // sitting above a button that would do something else.
    for (const el of [els.posModeOne, els.posModeSplit, els.posSupplier]) {
      if (el) el.addEventListener("change", openPosModal);
    }
    els.rfqModal.addEventListener("click", (event) => {
      if (event.target === els.rfqModal) els.rfqModal.hidden = true;
    });
    els.rfqConfirm.addEventListener("click", confirmGenerateRfqs);

    els.archiveButton.addEventListener("click", async () => {
      const archiving = state.list.status !== "archived";
      const verb = archiving ? "Archive" : "Restore";
      if (!(await pjlDialog.confirm(`${verb} this list?`, { title: `${verb} list`, confirmLabel: verb }))) return;
      const r = await fetch(`/api/material-lists/${encodeURIComponent(state.listId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: archiving ? "archived" : "draft" })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        await pjlDialog.alert((data.errors && data.errors[0]) || "Couldn't update status.", { title: "Update failed", icon: "warning" });
        return;
      }
      state.list = data.list;
      renderAll();
      setSaveState("saved", state.list.updatedAt);
    });

    els.deleteButton.addEventListener("click", async () => {
      const lineCount = (state.list.lineItems || []).length;
      const confirmText = lineCount
        ? `Delete this list and its ${lineCount} line item${lineCount === 1 ? "" : "s"}? This cannot be undone — archive is safer if you might need it later.`
        : "Delete this empty list?";
      if (!(await pjlDialog.confirm(confirmText, { title: "Delete list", icon: "delete", destructive: true, confirmLabel: "Delete" }))) return;
      const r = await fetch(`/api/material-lists/${encodeURIComponent(state.listId)}`, { method: "DELETE" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        await pjlDialog.alert((data.errors && data.errors[0]) || "Couldn't delete list.", { title: "Delete failed", icon: "warning" });
        return;
      }
      location.href = "/admin/material-lists";
    });

    // Save on page hide — ensures unsaved changes flush before nav-away.
    window.addEventListener("beforeunload", (event) => {
      if (!state.saveTimer && !state.pendingError) return;
      // Try a synchronous-ish save via fetch keepalive. Browsers don't
      // wait for it, but Render usually completes the round-trip in time.
      try {
        fetch(`/api/material-lists/${encodeURIComponent(state.listId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: state.list.name,
            customerName: state.list.customerName,
            customerEmail: state.list.customerEmail,
            address: state.list.address,
            notes: state.list.notes,
            lineItems: state.list.lineItems
          }),
          keepalive: true
        });
      } catch {}
      if (state.pendingError) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  }

  wireEvents();
  boot();
})();
