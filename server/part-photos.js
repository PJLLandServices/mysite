// Part photos admin — M1 of Part Photos & Supplier Identity (P-PJL-35).
//
// The manual way to give a part its verified photo: upload one, paste an
// image link, or say "this part is the same fitting as that one" so two
// SKUs share one photo. The server owns every rule (lib/part-photos.js);
// this page only shows what /api/part-photos returns and posts changes.
//
// In M3 the AI review queue lands on this page too.

(function () {
  const els = {
    list: document.getElementById("ppList"),
    search: document.getElementById("ppSearch"),
    count: document.getElementById("ppCount"),
    error: document.getElementById("ppError"),
    filters: document.querySelector(".pp-filters")
  };
  const state = { parts: [], groups: {}, filter: "all", q: "", openSku: null, openMode: null, busy: false };
  const params = new URLSearchParams(location.search);
  const focusSku = params.get("sku");

  const STATE_LABEL = {
    verified: "Verified photo",
    none: "No photo",
    tbd: "Waiting for review",
    not_confident: "No reliable photo",
    changed: "Part changed — reconfirm the photo"
  };
  const NO_PHOTO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h3l2-2.5h6L17 7h3v11.5H4z"/><circle cx="12" cy="12.5" r="3.5"/><path d="M3 3l18 18"/></svg>';

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function showError(msg) {
    els.error.textContent = msg || "";
    els.error.hidden = !msg;
  }
  const bySku = (sku) => state.parts.find((p) => p.sku === sku);
  const sharedCount = (p) => (p.groupId && state.groups[p.groupId] ? state.groups[p.groupId].skus.filter((s) => s !== p.sku).length : 0);

  async function load() {
    try {
      const r = await fetch("/api/part-photos", { cache: "no-store" });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || `HTTP ${r.status}`);
      const order = new Map((data.categories || []).map((c, i) => [c.key, i]));
      state.parts = data.parts.sort((a, b) =>
        (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || String(a.description).localeCompare(String(b.description)));
      state.groups = data.groups || {};
      showError("");
      render();
    } catch (err) {
      showError(`Couldn't load part photos: ${err.message}`);
      els.list.innerHTML = "";
    }
  }

  function matches(p) {
    if (state.filter === "verified" && p.photoState !== "verified") return false;
    if (state.filter === "nophoto" && p.photoState === "verified") return false;
    if (state.filter === "changed" && p.photoState !== "changed") return false;
    if (!state.q) return true;
    const hay = [p.sku, p.partNumber, p.description, p.size, p.manufacturer].join(" ").toLowerCase().replace(/["″]/g, "");
    return state.q.toLowerCase().replace(/["″]/g, "").split(/\s+/).every((t) => hay.includes(t));
  }

  function thumbHtml(p) {
    if (p.photoState === "verified" && p.photo) {
      return `<a class="pp-thumb is-verified" href="${esc(p.photo.large)}" target="_blank" rel="noopener" title="Open full size"><img src="${esc(p.photo.thumb)}" alt="" width="64" height="64" loading="lazy"></a>`;
    }
    return `<span class="pp-thumb is-nophoto" title="${esc(STATE_LABEL[p.photoState] || "No photo")}"><span class="pp-noph">${NO_PHOTO_SVG}<span>No photo</span></span></span>`;
  }

  function actionsHtml(p) {
    const b = [];
    b.push(`<button type="button" class="pp-btn pp-btn-primary" data-act="set">${p.photoState === "verified" ? "Replace photo" : "Set photo"}</button>`);
    b.push(`<button type="button" class="pp-btn" data-act="same">Same fitting as…</button>`);
    if (p.photoState === "changed") b.push(`<button type="button" class="pp-btn" data-act="reconfirm">Photo is still right</button>`);
    if (p.groupId) b.push(`<button type="button" class="pp-btn pp-btn-quiet" data-act="unlink">Unlink</button>`);
    if (p.photoState === "verified") b.push(`<button type="button" class="pp-btn pp-btn-danger" data-act="remove">Remove photo</button>`);
    return b.join("");
  }

  function panelHtml(p) {
    if (state.openSku !== p.sku) return "";
    const shared = sharedCount(p);
    const warn = shared ? `<p class="pp-warn">This photo is shared with ${shared} other part${shared > 1 ? "s" : ""} (the same fitting). Changing it changes it for all of them.</p>` : "";
    if (state.openMode === "set") {
      return `<div class="pp-panel" data-panel="set">
        ${warn}
        <div class="pp-panel-row">
          <label class="pp-field"><span>Upload a photo</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" data-input="file"></label>
          <div class="pp-or">or</div>
          <label class="pp-field"><span>Paste an image link (https://…)</span><input type="url" inputmode="url" placeholder="https://…/image.jpg" data-input="url"></label>
        </div>
        <p class="pp-hint">Use a photo of this exact part (right size and ends). It's only resized, never cropped or turned.</p>
        <div class="pp-panel-actions">
          <button type="button" class="pp-btn pp-btn-primary" data-act="save-photo">Save photo</button>
          <button type="button" class="pp-btn pp-btn-quiet" data-act="cancel">Cancel</button>
          <span class="pp-panel-status" data-status aria-live="polite"></span>
        </div>
      </div>`;
    }
    if (state.openMode === "same") {
      return `<div class="pp-panel" data-panel="same">
        <label class="pp-field"><span>Which part is this the same fitting as? (parts with a verified photo)</span>
          <input type="search" placeholder="Search parts with a photo" data-input="same-q" autocomplete="off"></label>
        <div class="pp-same-results" data-same-results></div>
        <div class="pp-panel-actions">
          <button type="button" class="pp-btn pp-btn-quiet" data-act="cancel">Cancel</button>
          <span class="pp-panel-status" data-status aria-live="polite"></span>
        </div>
      </div>`;
    }
    return "";
  }

  function rowHtml(p) {
    const shared = sharedCount(p);
    const sharedNames = shared ? state.groups[p.groupId].skus.filter((s) => s !== p.sku).join(", ") : "";
    return `<article class="pp-row ${state.openSku === p.sku ? "is-open" : ""}" data-sku="${esc(p.sku)}">
      <div class="pp-row-main">
        ${thumbHtml(p)}
        <div class="pp-info">
          <div class="pp-desc">${p.size ? `<span class="crm-parts-size pp-size">${esc(p.size)}</span> ` : ""}${esc(p.description || p.sku)}</div>
          <div class="pp-meta"><span class="pp-mono">${esc(p.sku)}</span>${p.manufacturer ? ` · ${esc(p.manufacturer)}` : ""}</div>
          <div class="pp-state is-${esc(p.photoState)}">${esc(STATE_LABEL[p.photoState] || "No photo")}${shared ? ` · shared with ${esc(sharedNames)}` : ""}</div>
        </div>
      </div>
      <div class="pp-actions">${actionsHtml(p)}</div>
      ${panelHtml(p)}
    </article>`;
  }

  function render() {
    const rows = state.parts.filter(matches);
    const verified = state.parts.filter((p) => p.photoState === "verified").length;
    els.count.textContent = `${verified} of ${state.parts.length} parts have a verified photo · showing ${rows.length}`;
    els.list.innerHTML = rows.length ? rows.map(rowHtml).join("") : `<p class="pp-empty">No parts match.</p>`;
    if (state.openMode === "same") renderSameResults();
  }

  function renderSameResults() {
    const row = els.list.querySelector(`.pp-row[data-sku="${CSS.escape(state.openSku || "")}"]`);
    if (!row) return;
    const box = row.querySelector("[data-same-results]");
    const qInput = row.querySelector("[data-input='same-q']");
    const q = (qInput && qInput.value || "").toLowerCase().trim();
    const current = bySku(state.openSku);
    const options = state.parts.filter((o) => o.sku !== state.openSku && o.photoState === "verified" && o.groupId !== (current && current.groupId))
      .filter((o) => !q || [o.sku, o.description, o.size, o.partNumber].join(" ").toLowerCase().includes(q))
      .slice(0, 12);
    box.innerHTML = options.length
      ? options.map((o) => `<button type="button" class="pp-same-option" data-act="link-to" data-target="${esc(o.sku)}">
          <img src="${esc(o.photo.thumb)}" alt="" width="40" height="40" loading="lazy">
          <span><b>${esc(o.description)}</b><span class="pp-mono">${esc(o.sku)}</span></span></button>`).join("")
      : `<p class="pp-empty">No other part with a verified photo matches.</p>`;
  }

  function setStatus(row, text, isError) {
    const s = row.querySelector("[data-status]");
    if (s) { s.textContent = text; s.classList.toggle("is-error", !!isError); }
  }

  async function post(url, body, method = "POST") {
    const r = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await r.json(); } catch (_) { /* empty */ }
    if (!r.ok || data.ok === false) throw new Error((data.errors && data.errors[0]) || `HTTP ${r.status}`);
    return data;
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.readAsDataURL(file);
    });
  }

  async function run(row, fn, busyText) {
    if (state.busy) return;
    state.busy = true;
    setStatus(row, busyText || "Saving…");
    row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await fn();
      state.openSku = null; state.openMode = null;
      await load();
    } catch (err) {
      row.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      if (row.querySelector("[data-status]")) setStatus(row, err.message, true);
      else showError(err.message);
    } finally {
      state.busy = false;
    }
  }

  els.list.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const row = btn.closest(".pp-row");
    const sku = row && row.dataset.sku;
    const p = sku && bySku(sku);
    if (!p) return;
    const act = btn.dataset.act;
    const enc = encodeURIComponent(sku);

    if (act === "set" || act === "same") {
      const same = state.openSku === sku && state.openMode === act;
      state.openSku = same ? null : sku;
      state.openMode = same ? null : act;
      render();
      const input = els.list.querySelector(`.pp-row[data-sku="${CSS.escape(sku)}"] [data-input]`);
      if (input && !same) input.focus();
      return;
    }
    if (act === "cancel") { state.openSku = null; state.openMode = null; render(); return; }

    if (act === "save-photo") {
      const file = row.querySelector("[data-input='file']").files[0];
      const url = row.querySelector("[data-input='url']").value.trim();
      if (!file && !url) { setStatus(row, "Choose a photo or paste a link first.", true); return; }
      if (file && file.size > 8 * 1024 * 1024) { setStatus(row, "That image is too large (8 MB max).", true); return; }
      await run(row, async () => {
        if (file) await post(`/api/part-photos/${enc}/photo`, { data: await readFileAsBase64(file) });
        else await post(`/api/part-photos/${enc}/photo`, { imageUrl: url });
      }, file ? "Uploading…" : "Downloading…");
      return;
    }
    if (act === "link-to") {
      const target = btn.dataset.target;
      const t = bySku(target);
      const ok = await window.pjlDialog.confirm(
        `Is ${p.sku} (${p.description}) the same physical fitting as ${target} (${t ? t.description : ""})? They'll share one photo.`,
        { confirmLabel: "Yes, same fitting", cancelLabel: "Cancel" });
      if (!ok) return;
      await run(row, () => post(`/api/part-photos/${enc}/link`, { sameAsSku: target }), "Linking…");
      return;
    }
    if (act === "reconfirm") {
      const ok = await window.pjlDialog.confirm(
        `${p.sku} was edited after its photo was matched. Open the photo and check it's still exactly this part before confirming.`,
        { confirmLabel: "Photo is still right", cancelLabel: "Cancel" });
      if (!ok) return;
      await run(row, () => post(`/api/part-photos/${enc}/reconfirm`), "Saving…");
      return;
    }
    if (act === "unlink") {
      const ok = await window.pjlDialog.confirm(
        `Unlink ${p.sku} from its photo? It will show "No photo" in the picker. Other parts sharing the photo keep it.`,
        { confirmLabel: "Unlink", cancelLabel: "Cancel" });
      if (!ok) return;
      await run(row, () => post(`/api/part-photos/${enc}/link`, null, "DELETE"), "Unlinking…");
      return;
    }
    if (act === "remove") {
      const shared = sharedCount(p);
      const ok = await window.pjlDialog.confirm(
        shared
          ? `Remove this photo? It's shared by ${shared + 1} parts (the same fitting), and all of them will show "No photo".`
          : `Remove the photo for ${p.sku}? It will show "No photo" in the picker.`,
        { confirmLabel: "Remove photo", cancelLabel: "Cancel", destructive: true });
      if (!ok) return;
      await run(row, () => post(`/api/part-photo-groups/${encodeURIComponent(p.groupId)}/photo`, null, "DELETE"), "Removing…");
    }
  });

  els.list.addEventListener("input", (e) => {
    if (e.target.matches("[data-input='same-q']")) renderSameResults();
  });

  els.filters.addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    state.filter = b.dataset.filter;
    els.filters.querySelectorAll("[data-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  });
  let t = null;
  els.search.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = els.search.value.trim(); render(); }, 120);
  });

  // Arriving from the picker's "Set a photo for this part" link.
  if (focusSku) {
    els.search.value = focusSku;
    state.q = focusSku;
    state.openSku = focusSku;
    state.openMode = "set";
  }
  load();
})();
