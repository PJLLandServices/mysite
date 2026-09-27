// Photo Review — M3b of Part Photos & Supplier Identity (P-PJL-35).
//
// The Review tab on Materials → Part photos. Everything the AI backfill
// could not make live on its own comes here, one card per fitting:
//   To be determined · Not confident · Recently auto-approved · Fittings to confirm
// Approve / Reject / Upload my own / Next, by tap or keyboard (A, R, →).
// The server owns every rule (lib/part-photos.js, lib/photo-review.js);
// this page only shows /api/part-photo-review and posts decisions.
// Nothing here starts an AI run — that is held for M3c.

(function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: document.querySelector(".pp-tabs"),
    review: $("reviewView"), parts: $("partsView"), badge: $("ppReviewBadge"),
    progress: $("prProgress"), queues: $("prQueues"), list: $("prList"), error: $("prError"), keys: $("prKeys"),
    zoom: $("prZoom"), zoomImg: $("prZoomImg")
  };
  if (!els.review) return;

  const QUEUES = [
    { key: "tbd", label: "To be determined", empty: "Nothing waiting for review." },
    { key: "notConfident", label: "Not confident", empty: "No parts without a reliable photo." },
    { key: "autoApproved", label: "Recently auto-approved", empty: "Nothing has gone live automatically yet." },
    { key: "fittings", label: "Fittings to confirm", empty: "No same-fitting suggestions to confirm." }
  ];
  const state = { data: null, queue: "tbd", cur: 0, pick: {}, busy: false, tab: "parts" };
  const params = new URLSearchParams(location.search);

  const CHECK_LABEL = {
    partNumber: "Part # on page", specMatch: "Spec on page", crossSource: "Second source",
    productShot: "Single product shot", type: "Type", ends: "Ends", reducing: "Reducing / straight",
    angle: "Angle", material: "Material / colour", pack: "Pack / count", size: "Size"
  };
  const MARK = { pass: "✓", fail: "✗", unknown: "?", "n/a": "–" };
  const PASS_LABEL = { 1: "Manufacturer site", 2: "Supplier site", 3: "Open web" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  const img = (hash, size) => `/api/part-photos/${hash}/${size}.webp`;
  const safeHref = (u) => (/^https:\/\//i.test(String(u || "")) ? esc(u) : "");
  function showError(msg) { els.error.textContent = msg || ""; els.error.hidden = !msg; }

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
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

  // ---- tabs ------------------------------------------------------------
  function setTab(tab, push) {
    state.tab = tab;
    els.tabs.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    els.review.hidden = tab !== "review";
    els.parts.hidden = tab !== "parts";
    if (push) history.replaceState(null, "", tab === "review" ? "#review" : location.pathname + location.search);
    if (tab === "review") load(!!state.data);
  }
  els.tabs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) setTab(b.dataset.tab, true);
  });

  // ---- data --------------------------------------------------------------
  async function load(keepPlace) {
    try {
      const r = await fetch("/api/part-photo-review", { cache: "no-store" });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || `HTTP ${r.status}`);
      state.data = data;
      if (!keepPlace && !data[state.queue].length) {
        const first = QUEUES.find((q) => data[q.key].length);
        if (first) state.queue = first.key;
      }
      state.cur = Math.min(state.cur, Math.max(0, data[state.queue].length - 1));
      showError("");
      renderBadge();
      render();
      schedulePoll();
    } catch (err) {
      showError(`Couldn't load the review queue: ${err.message}`);
      els.list.innerHTML = "";
    }
  }
  function waiting(d) { return d.tbd.length + d.fittings.length; }
  function renderBadge() {
    const n = state.data ? waiting(state.data) : 0;
    els.badge.textContent = String(n);
    els.badge.hidden = !n;
  }

  // ---- progress panel ------------------------------------------------------
  function progressHtml(d) {
    const p = d.progress || {};
    const total = p.total || 0;
    const seg = [
      ["live", "Live", p.live || 0, p.live ? `${p.liveAuto || 0} auto · ${(p.live || 0) - (p.liveAuto || 0)} approved by you` : ""],
      ["review", "Review needed", p.review || 0, ""],
      ["noreliable", "No reliable photo", p.noReliable || 0, ""],
      ["pending", "Not processed yet", p.notProcessed || 0, ""]
    ];
    const bar = seg.map(([k, , n]) => (n ? `<span class="pr-bar-seg is-${k}" style="flex-grow:${n}"></span>` : "")).join("");
    const stats = seg.map(([k, label, n, sub]) => `<div class="pr-stat is-${k}"><b>${n}</b><span>${label}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`).join("")
      + `<div class="pr-stat is-errors"><b>${p.errors || 0}</b><span>Errors</span></div>`;
    const run = d.run;
    const active = run && (run.status === "running" || run.status === "paused");
    let runLine = "No AI run yet.";
    if (run) {
      const c = run.counts;
      const where = run.current ? ` · now on <span class="pp-mono">${esc(run.current.sku)}</span> (${esc(run.current.step)})` : "";
      const u = run.usage || {};
      runLine = `${run.calibration ? (run.calibration.rerunOf ? "Calibration re-run" : "Calibration run") : "AI run"} <b>${esc(run.label || run.id)}</b> · <b>${esc(run.status === "paused" && run.interruptedAt ? "interrupted by a restart — press Resume" : run.status)}</b> · ${c.done} of ${c.total} done${c.error ? ` · ${c.error} error${c.error > 1 ? "s" : ""}` : ""}${where} · auto-approve <b>${run.autoApprove ? "ON" : "off"}</b>`
        + `<br><span class="pr-usage">${(u.calls || 0)} Claude calls · ${(u.searches || 0)} web searches · ${(u.webFetches || 0)} model fetches · ${(u.pageFetches || 0)} pages + ${(u.imageFetches || 0)} images fetched by our server · ${(u.in || 0).toLocaleString()} in / ${(u.out || 0).toLocaleString()} out tokens</span>`;
    }
    const errors = run && run.errors && run.errors.length
      ? `<ul class="pr-run-errors">${run.errors.map((e) => `<li><span class="pp-mono">${esc(e.sku)}</span> at ${esc(e.step || "?")}: ${esc(e.error || "")}</li>`).join("")}</ul>` : "";
    // Controls. Start is the calibration run ONLY (15 parts, auto-approve
    // off) and is offered only when no run is active. There is no
    // whole-catalog button yet.
    let controls = "";
    if (run && run.status === "running") controls = `<button type="button" class="pp-btn" data-act="pause">Pause</button>`;
    else if (run && run.status === "paused") controls = `<button type="button" class="pp-btn pp-btn-primary" data-act="resume">Resume</button>`;
    else {
      const unresolved = run && run.calibration && run.calibration.unresolved ? run.calibration.unresolved : [];
      controls = (unresolved.length
        ? `<button type="button" class="pp-btn pp-btn-primary" data-act="rerun"${d.apiKeySet === false ? " disabled" : ""}>Re-run the ${unresolved.length} unresolved calibration part${unresolved.length > 1 ? "s" : ""} (auto-approve off)</button>`
        : "")
        + `<button type="button" class="pp-btn${unresolved.length ? "" : " pp-btn-primary"}" data-act="start-cal"${d.apiKeySet === false ? " disabled" : ""}>Start calibration run (15 parts, auto-approve off)</button>${d.apiKeySet === false ? `<span class="pr-held">ANTHROPIC_API_KEY isn't set on the server.</span>` : ""}`;
    }
    return `<div class="pr-progress-head"><h2>Photos across the catalog</h2><span>${total} parts</span></div>
      <div class="pr-bar" role="img" aria-label="${p.live || 0} live, ${p.review || 0} review needed, ${p.noReliable || 0} no reliable photo, ${p.notProcessed || 0} not processed">${bar || '<span class="pr-bar-seg is-pending" style="flex-grow:1"></span>'}</div>
      <div class="pr-stats">${stats}</div>
      <p class="pr-run">${runLine}</p>${errors}
      <div class="pr-controls">${controls}<span class="pp-panel-status" data-status aria-live="polite"></span></div>`;
  }

  // While a run is going, the panel refreshes itself every few seconds.
  function schedulePoll() {
    clearTimeout(state.poll);
    const run = state.data && state.data.run;
    if (state.tab === "review" && run && run.status === "running") state.poll = setTimeout(() => load(true), 5000);
  }

  async function startCalibration() {
    const s = els.progress.querySelector("[data-status]");
    const say = (t, bad) => { if (s) { s.textContent = t; s.classList.toggle("is-error", !!bad); } };
    say("Checking the plan…");
    let plan;
    try {
      const r = await fetch("/api/part-photo-backfill/plan", { cache: "no-store" });
      plan = await r.json();
      if (!r.ok || !plan.ok) throw new Error((plan.errors && plan.errors[0]) || `HTTP ${r.status}`);
    } catch (err) { say(`Couldn't read the plan: ${err.message}`, true); return; }
    say("");
    if (!plan.skus.length) { say("Nothing to calibrate — every sample part already has a live photo.", true); return; }
    const e = plan.estimate;
    const list = plan.rows.map((r) => `${r.sku} (${r.kind}${r.manufacturer ? ", " + r.manufacturer : ""}) — ${r.description}`).join("\n");
    const ok = await window.pjlDialog.confirm(
      `Start the calibration run on these ${plan.counts.total} parts (${plan.counts.branded} branded, ${plan.counts.generic} generic)? Auto-approve is OFF: nothing goes live until you approve it on this tab.\n\n${list}\n\nAt most ${e.apiCalls.max} Claude calls (${e.finderCalls.max} finder, ${e.verifyCalls.max} vision, ${e.compareCalls.max} compare), up to ${e.webSearches.max} web searches, and up to ${e.pagesFetchedByOurServer.max} pages + ${e.imagesFetchedByOurServer.max} images fetched by our server.`,
      { confirmLabel: "Start calibration", cancelLabel: "Cancel" });
    if (!ok) return;
    await backfillAction("calibration", "Starting…");
  }
  async function rerunUnresolved() {
    const run = state.data && state.data.run;
    const skus = run && run.calibration && run.calibration.unresolved || [];
    if (!skus.length) return;
    const ok = await window.pjlDialog.confirm(
      `Re-run only the ${skus.length} calibration part${skus.length > 1 ? "s" : ""} that still have no live photo? Auto-approve is OFF: nothing goes live until you approve it here.\n\n${skus.join(", ")}`,
      { confirmLabel: "Re-run these parts", cancelLabel: "Cancel" });
    if (!ok) return;
    await backfillAction("rerun-unresolved", "Starting…");
  }
  async function backfillAction(action, busy) {
    const s = els.progress.querySelector("[data-status]");
    if (s) { s.textContent = busy; s.classList.remove("is-error"); }
    els.progress.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await post(`/api/part-photo-backfill/${action}`, {});
      await load(true);
    } catch (err) {
      els.progress.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      if (s) { s.textContent = err.message; s.classList.add("is-error"); }
    }
  }
  els.progress.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || state.busy) return;
    if (b.dataset.act === "start-cal") startCalibration();
    else if (b.dataset.act === "rerun") rerunUnresolved();
    else if (b.dataset.act === "pause") backfillAction("pause", "Pausing…");
    else if (b.dataset.act === "resume") backfillAction("resume", "Resuming…");
  });

  function queuesHtml(d) {
    return QUEUES.map((q) => `<button type="button" role="tab" data-queue="${q.key}" aria-selected="${q.key === state.queue}">${q.label} <span class="pr-count">${d[q.key].length}</span></button>`).join("");
  }

  // ---- cards ---------------------------------------------------------------
  function checkItems(checks) {
    const out = [];
    const add = (key, c, extra) => { if (c && c.result) out.push({ key, result: c.result, reason: (c.reason || "") + (extra || "") }); };
    add("partNumber", checks.partNumber);
    add("specMatch", checks.specMatch);
    add("crossSource", checks.crossSource);
    const v = checks.vision || {};
    for (const k of ["productShot", "type", "ends", "reducing", "angle", "material", "pack", "size"]) add(k, v[k]);
    return out;
  }
  function checksHtml(checks) {
    const items = checkItems(checks || {});
    if (!items.length) return `<p class="pr-nochecks">No checks recorded.</p>`;
    const problems = items.filter((i) => i.result === "fail" || i.result === "unknown");
    return `<ul class="pr-checks">${items.map((i) => `<li class="is-${i.result === "n/a" ? "na" : i.result}" title="${esc(i.reason)}"><span aria-hidden="true">${MARK[i.result] || "?"}</span>${CHECK_LABEL[i.key] || i.key}<span class="pr-sr"> — ${esc(i.result)}</span></li>`).join("")}</ul>
      ${problems.length ? `<ul class="pr-why">${problems.map((i) => `<li><b>${CHECK_LABEL[i.key] || i.key}:</b> ${esc(i.reason || i.result)}</li>`).join("")}</ul>` : ""}`;
  }
  function partHtml(p, also, extra) {
    const nums = [p.partNumber && p.partNumber !== p.sku ? `Part # <span class="pp-mono">${esc(p.partNumber)}</span>` : "",
      p.supplierSkus && p.supplierSkus.length ? `Supplier # <span class="pp-mono">${p.supplierSkus.map(esc).join(", ")}</span>` : ""].filter(Boolean).join(" · ");
    return `<div class="pr-part">
      <div class="pp-desc">${p.size ? `<span class="crm-parts-size pp-size">${esc(p.size)}</span> ` : ""}${esc(p.description || p.sku)}</div>
      <div class="pp-meta"><span class="pp-mono">${esc(p.sku)}</span>${p.manufacturer ? ` · ${esc(p.manufacturer)}` : " · generic"}${nums ? ` · ${nums}` : ""}</div>
      ${also && also.length ? `<div class="pp-meta">Same fitting: ${also.map((a) => `<span class="pp-mono">${esc(a.sku)}</span>`).join(", ")}</div>` : ""}
      ${extra || ""}
    </div>`;
  }
  function candHtml(card, c, i, selected) {
    const src = c.source || {};
    const href = safeHref(src.pageUrl);
    return `<figure class="pr-cand${selected ? " is-selected" : ""}" data-hash="${esc(c.hash)}" data-idx="${i}">
      <button type="button" class="pr-cand-img" data-act="zoom" data-hash="${esc(c.hash)}" aria-label="Photo ${i + 1}, open full size">
        <img src="${img(c.hash, 480)}" alt="Candidate photo ${i + 1} for ${esc(card.part.description)}" loading="lazy">
        <span class="pr-cand-n" aria-hidden="true">${i + 1}</span>
      </button>
      <figcaption>
        <p class="pr-src">${esc(src.domain || "unknown site")}${src.official ? ' <span class="pr-official">official</span>' : ""}${src.pass ? ` · ${PASS_LABEL[src.pass] || ""}` : ""}${href ? ` · <a href="${href}" target="_blank" rel="noopener noreferrer">Open page ↗</a>` : ""}</p>
        ${checksHtml(c.checks)}
      </figcaption>
      ${card.queue === "autoApproved" ? "" : `<button type="button" class="pp-btn pp-btn-primary pr-approve" data-act="approve" data-hash="${esc(c.hash)}">Approve this photo</button>`}
    </figure>`;
  }
  const TIER_LABEL = { tbd: "To be determined", not_confident: "Not confident", confident: "Auto-approved", approved: "Approved" };

  function reviewCardHtml(card, idx, queue) {
    card.queue = queue;
    const isCur = idx === state.cur;
    const picked = state.pick[card.groupId] || 0;
    let photos;
    if (queue === "autoApproved") {
      const live = card.candidates.find((c) => card.photo && c.hash === card.photo.hash) || (card.photo ? { hash: card.photo.hash, source: {}, checks: {} } : null);
      photos = live ? candHtml(card, live, 0, true) : "";
    } else {
      photos = card.candidates.length
        ? card.candidates.map((c, i) => candHtml(card, c, i, i === picked)).join("")
        : `<div class="pr-nocand"><b>No candidate photo.</b> Upload your own if you have one.</div>`;
    }
    const ident = (card.proposedBrand
      ? `<div class="pp-meta">Brand proposed from the description: <b>${esc(card.proposedBrand)}</b> (the catalog's manufacturer is blank and was not changed)</div>` : "")
      + (card.identified && card.identified.manufacturerPartNumber
      ? `<div class="pp-meta">AI matched it to <b>${esc(card.identified.manufacturer || "")} ${esc(card.identified.manufacturerPartNumber)}</b></div>` : "");
    const reason = `<div class="pr-reason is-${esc(card.tier)}"><b>${TIER_LABEL[card.tier] || card.tier}</b>${card.reason ? ` — ${esc(card.reason)}` : ""}</div>`;
    const actions = queue === "autoApproved"
      ? `<button type="button" class="pp-btn pp-btn-danger" data-act="reject">Reject — take it down</button>
         <button type="button" class="pp-btn pp-btn-quiet" data-act="next">Next →</button>`
      : `<button type="button" class="pp-btn pp-btn-danger" data-act="reject">${card.candidates.length ? "Reject — none are right" : "Mark: no reliable photo"}</button>
         <label class="pp-btn pr-upload">Upload my own<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" data-act="upload" hidden></label>
         <button type="button" class="pp-btn pp-btn-quiet" data-act="next">Next →</button>`;
    return `<article class="pr-card${isCur ? " is-current" : ""}" data-idx="${idx}" data-sku="${esc(card.sku)}" data-group="${esc(card.groupId)}" tabindex="-1" aria-label="${esc(card.part.description)}">
      <header class="pr-card-head">${partHtml(card.part, card.also, ident + reason)}</header>
      <div class="pr-cands${queue === "autoApproved" ? " is-single" : ""}">${photos}</div>
      <footer class="pr-actions">${actions}<span class="pp-panel-status" data-status aria-live="polite"></span></footer>
    </article>`;
  }

  function fittingSideHtml(f, side, other) {
    const s = f[side];
    const pv = s.preview;
    const pic = pv && pv.hash
      ? `<button type="button" class="pr-cand-img" data-act="zoom" data-hash="${esc(pv.hash)}" aria-label="Open full size"><img src="${img(pv.hash, 480)}" alt="Photo for ${esc(s.description)}" loading="lazy"></button>
         <p class="pr-src">${pv.kind === "live" ? "Live photo" : "AI candidate (not live)"}</p>`
      : `<div class="pr-nocand">No photo yet</div>`;
    return `<div class="pr-side">
      ${pic}
      ${partHtml(s)}
      <button type="button" class="pp-btn pp-btn-primary" data-act="fit-confirm" data-keep="${esc(s.sku)}"${pv && pv.hash ? "" : " disabled"}>Same fitting — use this photo</button>
    </div>`;
  }
  function fittingCardHtml(f, idx) {
    return `<article class="pr-card pr-fitting${idx === state.cur ? " is-current" : ""}" data-idx="${idx}" data-fitting="${esc(f.id)}" tabindex="-1">
      <p class="pr-reason is-tbd"><b>Same fitting?</b> ${esc(f.reason || "")}</p>
      <div class="pr-sides">${fittingSideHtml(f, "a", "b")}${fittingSideHtml(f, "b", "a")}</div>
      <footer class="pr-actions">
        <button type="button" class="pp-btn" data-act="fit-dismiss">Not the same fitting</button>
        <button type="button" class="pp-btn pp-btn-quiet" data-act="next">Next →</button>
        <span class="pp-panel-status" data-status aria-live="polite"></span>
      </footer>
    </article>`;
  }

  function render() {
    const d = state.data;
    if (!d) return;
    els.progress.innerHTML = progressHtml(d);
    els.queues.innerHTML = queuesHtml(d);
    const items = d[state.queue];
    const q = QUEUES.find((x) => x.key === state.queue);
    if (!items.length) { els.list.innerHTML = `<p class="pp-empty">${q.empty}</p>`; return; }
    els.list.innerHTML = `<p class="pr-pos">${state.cur + 1} of ${items.length}</p>` + items.map((it, i) =>
      state.queue === "fittings" ? fittingCardHtml(it, i) : reviewCardHtml(it, i, state.queue)).join("");
  }
  function currentCardEl() { return els.list.querySelector(".pr-card.is-current"); }
  function go(delta, focus = true) {
    const items = state.data ? state.data[state.queue] : [];
    if (!items.length) return;
    state.cur = Math.max(0, Math.min(items.length - 1, state.cur + delta));
    els.list.querySelectorAll(".pr-card").forEach((c) => c.classList.toggle("is-current", Number(c.dataset.idx) === state.cur));
    const pos = els.list.querySelector(".pr-pos");
    if (pos) pos.textContent = `${state.cur + 1} of ${items.length}`;
    const el = currentCardEl();
    if (el && focus) { el.scrollIntoView({ block: "start", behavior: "smooth" }); el.focus({ preventScroll: true }); }
  }
  function pickCandidate(card, i) {
    const cardData = state.data[state.queue][Number(card.dataset.idx)];
    if (!cardData || !cardData.candidates || i >= cardData.candidates.length) return;
    state.pick[cardData.groupId] = i;
    card.querySelectorAll(".pr-cand").forEach((f) => f.classList.toggle("is-selected", Number(f.dataset.idx) === i));
  }

  // ---- actions -------------------------------------------------------------
  function setStatus(card, text, isError) {
    const s = card && card.querySelector("[data-status]");
    if (s) { s.textContent = text; s.classList.toggle("is-error", !!isError); }
  }
  async function act(card, fn, busyText) {
    if (state.busy) return;
    state.busy = true;
    setStatus(card, busyText || "Saving…");
    card.querySelectorAll("button, input").forEach((b) => { b.disabled = true; });
    try {
      await fn();
      await load(true);
      go(0);
    } catch (err) {
      card.querySelectorAll("button, input").forEach((b) => { b.disabled = false; });
      setStatus(card, err.message, true);
    } finally {
      state.busy = false;
    }
  }

  async function approve(card, hash) {
    const data = state.data[state.queue][Number(card.dataset.idx)];
    if (!data || !hash) return;
    const shared = data.also && data.also.length;
    await act(card, () => post(`/api/part-photo-review/${encodeURIComponent(data.sku)}/approve`, { hash }),
      shared ? `Approving for ${data.also.length + 1} parts…` : "Approving…");
  }
  async function reject(card) {
    const data = state.data[state.queue][Number(card.dataset.idx)];
    if (!data) return;
    if (state.queue === "autoApproved") {
      const ok = await window.pjlDialog.confirm(
        `Take down the photo for ${data.sku} (${data.part.description})? It will show "No photo" in the picker. Every other photo that went live automatically by the same rule in that run is also taken down and sent back to "To be determined" for you to check.`,
        { confirmLabel: "Reject and send back", cancelLabel: "Cancel", destructive: true });
      if (!ok) return;
    }
    await act(card, () => post(`/api/part-photo-review/${encodeURIComponent(data.sku)}/reject`, {}), "Rejecting…");
  }
  async function upload(card, file) {
    const data = state.data[state.queue][Number(card.dataset.idx)];
    if (!data || !file) return;
    if (file.size > 8 * 1024 * 1024) { setStatus(card, "That image is too large (8 MB max).", true); return; }
    await act(card, async () => post(`/api/part-photos/${encodeURIComponent(data.sku)}/photo`, { data: await readFileAsBase64(file) }), "Uploading…");
  }
  async function fitting(card, action, keep) {
    const f = state.data.fittings[Number(card.dataset.idx)];
    if (!f) return;
    if (action === "confirm") {
      const mover = keep === f.a.sku ? f.b : f.a;
      const kept = keep === f.a.sku ? f.a : f.b;
      const ok = await window.pjlDialog.confirm(
        `${mover.sku} (${mover.description}) and ${kept.sku} (${kept.description}) are the same physical fitting? They'll share ${kept.sku}'s photo${kept.preview && kept.preview.kind === "candidate" ? " once it's approved" : ""}.`,
        { confirmLabel: "Yes, same fitting", cancelLabel: "Cancel" });
      if (!ok) return;
    }
    await act(card, () => post(`/api/part-photo-review/fittings/${encodeURIComponent(f.id)}`, { action, keep }), "Saving…");
  }

  els.queues.addEventListener("click", (e) => {
    const b = e.target.closest("[data-queue]");
    if (!b) return;
    state.queue = b.dataset.queue;
    state.cur = 0;
    render();
  });
  els.list.addEventListener("click", (e) => {
    const card = e.target.closest(".pr-card");
    if (!card) return;
    if (Number(card.dataset.idx) !== state.cur) { state.cur = Number(card.dataset.idx); go(0, false); }
    const btn = e.target.closest("[data-act]");
    const fig = e.target.closest(".pr-cand");
    if (fig && (!btn || btn.dataset.act === "zoom")) pickCandidate(card, Number(fig.dataset.idx));
    if (!btn) return;
    const a = btn.dataset.act;
    if (a === "zoom") { els.zoomImg.src = img(btn.dataset.hash, 1200); els.zoom.showModal(); return; }
    if (a === "approve") return approve(card, btn.dataset.hash);
    if (a === "reject") return reject(card);
    if (a === "next") return go(1);
    if (a === "fit-confirm") return fitting(card, "confirm", btn.dataset.keep);
    if (a === "fit-dismiss") return fitting(card, "dismiss");
  });
  els.list.addEventListener("change", (e) => {
    if (e.target.matches("input[data-act='upload']")) upload(e.target.closest(".pr-card"), e.target.files[0]);
  });
  els.zoom.addEventListener("click", (e) => { if (e.target === els.zoom || e.target === els.zoomImg) els.zoom.close(); });

  document.addEventListener("keydown", (e) => {
    if (state.tab !== "review" || !state.data || state.busy) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open], .pjl-dialog-panel")) return;
    const card = currentCardEl();
    if (!card) return;
    const k = e.key;
    if (k === "ArrowRight" || k === "j") { e.preventDefault(); go(1); }
    else if (k === "ArrowLeft" || k === "k") { e.preventDefault(); go(-1); }
    else if (/^[1-3]$/.test(k) && state.queue !== "fittings") { e.preventDefault(); pickCandidate(card, Number(k) - 1); }
    else if ((k === "a" || k === "A") && (state.queue === "tbd" || state.queue === "notConfident")) {
      const sel = card.querySelector(".pr-cand.is-selected");
      if (sel) { e.preventDefault(); approve(card, sel.dataset.hash); }
    } else if ((k === "r" || k === "R") && state.queue !== "fittings") { e.preventDefault(); reject(card); }
  });

  // Start on Review when asked (#review), or when something is waiting and
  // the page wasn't opened for one part (?sku= from the picker).
  if (location.hash === "#review") setTab("review");
  else if (!params.get("sku")) {
    fetch("/api/part-photo-review", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      if (!d || !d.ok) return;
      els.badge.textContent = String(waiting(d));
      els.badge.hidden = !waiting(d);
      if (waiting(d)) setTab("review");
    }).catch(() => {});
  }
})();
