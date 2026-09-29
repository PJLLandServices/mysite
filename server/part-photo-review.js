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
    { key: "needsResearch", label: "Needs research", empty: "Every part the cheap lookup missed has been dealt with." },
    { key: "autoApproved", label: "Recently auto-approved", empty: "Nothing has gone live automatically yet." },
    { key: "fittings", label: "Fittings to confirm", empty: "No same-fitting suggestions to confirm." },
    { key: "quality", label: "Quality", empty: "No live photo is waiting for a quality decision." }
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
      ["research", "Needs research", p.needsResearch || 0, "the cheap lookup found nothing; no web search was made"],
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
      const what = run.benchmark ? "Fast-path benchmark (dry run — nothing saved)" : run.calibration ? (run.calibration.rerunOf ? "Calibration re-run" : "Calibration run") : run.wave ? "Wave" : "AI run";
      const f = run.fast || {};
      const fastLine = (f.hits || f.fastAndAi || f.aiOnly)
        ? `<br><span class="pr-usage">fast path: ${f.hits || 0} resolved without the finder · ${f.fastAndAi || 0} with finder help · ${f.aiOnly || 0} finder only${run.timing && run.timing.avgMs ? ` · ${Math.round(run.timing.avgMs / 1000)} s per part` : ""}</span>` : "";
      const b = run.budget || {};
      const money = `<br><span class="pr-usage pr-money">this run <b>$${(run.costUsd || 0).toFixed(2)}</b> · budget <b>$${(b.spentUsd || 0).toFixed(2)}</b> spent of <b>$${b.usd != null ? b.usd : "∞"}</b>${b.remainingUsd != null ? ` · $${b.remainingUsd.toFixed(2)} left` : ""} · web search <b>${run.finder ? "ON (not a wave)" : "never"}</b>${run.models ? ` · vision ${esc(run.models.vision)}` : ""}</span>`;
      const paused = run.status === "paused" && run.pausedReason === "budget" ? "paused — the photo budget is used up" : run.status === "paused" && run.interruptedAt ? "interrupted by a restart — press Resume" : run.status;
      runLine = `${what} <b>${esc(run.label || run.id)}</b> · <b>${esc(paused)}</b> · ${c.done} of ${c.total} done${c.error ? ` · ${c.error} error${c.error > 1 ? "s" : ""}` : ""}${where} · auto-approve <b>${run.autoApprove ? "ON" : "off"}</b>` + money
        + `<br><span class="pr-usage">${(u.calls || 0)} Claude calls · ${(u.searches || 0)} web searches · ${(u.webFetches || 0)} model fetches · ${(u.fastSearches || 0)} supplier searches + ${(u.pageFetches || 0)} pages + ${(u.imageFetches || 0)} images fetched by our server · ${(u.in || 0).toLocaleString()} in / ${(u.out || 0).toLocaleString()} out tokens</span>`
        + (run.usageByKind ? `<br><span class="pr-usage">${["branded", "generic"].map((k) => { const b = run.usageByKind[k]; return b && b.parts ? `${k}: ${b.parts} part${b.parts === 1 ? "" : "s"} · ${b.perPart.calls} calls · ${b.perPart.searches} searches · ${b.perPart.in.toLocaleString()} in / ${b.perPart.out.toLocaleString()} out tokens per part` : `${k}: none`; }).join(" — ")}</span>` : "")
        + fastLine;
    }
    const bench = run && run.benchmark && run.benchmark.rows ? benchmarkHtml(run) : "";
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
        + `<button type="button" class="pp-btn${unresolved.length ? "" : " pp-btn-primary"}" data-act="start-cal"${d.apiKeySet === false ? " disabled" : ""}>Start calibration run (15 parts, auto-approve off)</button>`
        + `<button type="button" class="pp-btn" data-act="start-wave"${d.apiKeySet === false ? " disabled" : ""}>Start the next wave (up to 50 parts, auto-approve off)</button>`
        + `<button type="button" class="pp-btn" data-act="benchmark"${d.apiKeySet === false ? " disabled" : ""}>Run the fast-path benchmark (10 parts, dry run — nothing saved)</button>${d.apiKeySet === false ? `<span class="pr-held">ANTHROPIC_API_KEY isn't set on the server.</span>` : ""}`;
    }
    return `<div class="pr-progress-head"><h2>Photos across the catalog</h2><span>${total} parts</span></div>
      <div class="pr-bar" role="img" aria-label="${p.live || 0} live, ${p.review || 0} review needed, ${p.noReliable || 0} no reliable photo, ${p.needsResearch || 0} needs research, ${p.notProcessed || 0} not processed">${bar || '<span class="pr-bar-seg is-pending" style="flex-grow:1"></span>'}</div>
      <div class="pr-stats">${stats}</div>
      <p class="pr-run">${runLine}</p>${errors}${bench}
      <div class="pr-controls">${controls}<span class="pp-panel-status" data-status aria-live="polite"></span></div>`;
  }
  // The benchmark report: one row per part — how it was resolved, the
  // verdict, the chosen photo's source size and grade, what it cost and how
  // long it took — under the last wave's per-part averages for comparison.
  function benchmarkHtml(run) {
    const b = run.benchmark;
    const base = b.baseline;
    const baseLine = base && base.usageByKind
      ? `<p class="pr-bench-base">Baseline — ${esc(base.label || base.runId)}: ${["branded", "generic"].map((k) => { const x = base.usageByKind[k]; return x && x.parts && x.perPart ? `${k} ${x.perPart.calls} calls · ${x.perPart.searches} searches · ${x.perPart.in.toLocaleString()} in tokens per part` : ""; }).filter(Boolean).join(" — ")}</p>`
      : `<p class="pr-bench-base">No earlier run on file to compare with.</p>`;
    const via = { fast: "fast path", "fast+ai": "fast path + finder", ai: "finder only" };
    const rows = b.rows.map((r) => {
      const ch = r.chosen;
      const photo = ch ? `${ch.imageSource ? `${ch.imageSource.width}×${ch.imageSource.height}` : `${ch.width || "?"}×${ch.height || "?"}`}${ch.quality ? ` · ${esc(ch.quality.grade)}` : ""}${ch.domain ? ` · ${esc(ch.domain)}` : ""}` : (r.step === "done" ? "none" : "…");
      const result = r.step === "done" ? `${TIER_LABEL[r.tier] === "Auto-approved" ? "Confident" : TIER_LABEL[r.tier] || r.tier || ""}${r.qualityCapped ? " (quality cap)" : ""}` : r.step === "error" ? `error: ${esc(r.reason || "")}` : esc(r.step);
      return `<tr><td class="pp-mono">${esc(r.sku)}</td><td>${esc(r.kind || "")}</td><td>${esc(via[r.via] || (r.step === "done" ? "—" : "…"))}</td><td>${result}</td><td>${photo}</td><td>${r.usage.calls}</td><td>${r.usage.in.toLocaleString()}</td><td>${r.usage.searches}</td><td>${r.usage.fastSearches}</td><td>${r.ms != null ? Math.round(r.ms / 1000) : "…"}</td></tr>`;
    }).join("");
    return `<div class="pr-bench">${baseLine}<div class="pr-bench-scroll"><table><thead><tr><th>SKU</th><th>Kind</th><th>Resolved by</th><th>Result</th><th>Chosen photo (source)</th><th>Claude calls</th><th>In tokens</th><th>Web searches</th><th>Supplier searches</th><th>Seconds</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
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
  // The wave: show the exact plan, then send back the very list that was
  // shown — the server refuses anything else.
  async function startWave() {
    const s = els.progress.querySelector("[data-status]");
    const say = (t, bad) => { if (s) { s.textContent = t; s.classList.toggle("is-error", !!bad); } };
    say("Building the wave plan…");
    let plan;
    try {
      const r = await fetch("/api/part-photo-backfill/wave-plan", { cache: "no-store" });
      plan = await r.json();
      if (!r.ok || !plan.ok) throw new Error((plan.errors && plan.errors[0]) || `HTTP ${r.status}`);
    } catch (err) { say(`Couldn't build the plan: ${err.message}`, true); return; }
    say("");
    if (!plan.skus.length) { say("Nothing left to process — every eligible part is live, waiting for review, or already run.", true); return; }
    const e = plan.estimate;
    const list = plan.rows.map((r) => `${r.sku} (${r.kind}${r.manufacturer ? ", " + r.manufacturer : ""}) — ${r.description}`).join("\n");
    const cost = plan.cost || {};
    const ok = await window.pjlDialog.confirm(
      `Start a wave on these ${plan.counts.total} unprocessed parts (${plan.counts.branded} branded, ${plan.counts.generic} generic; categories: ${plan.counts.categories.join(", ")})? Auto-approve is OFF: nothing goes live until you approve it on this tab. No web search is ever made in a wave: a part the supplier sites can't resolve goes to Needs research and the wave moves on.\n\n${list}\n\nWorst case: $${(cost.worstCaseUsd || 0).toFixed(2)} (${e.verifyCalls.max} vision + ${e.compareCalls.max} compare calls on ${cost.models ? cost.models.vision : "?"}). Budget: $${(cost.spentUsd || 0).toFixed(2)} spent of $${cost.budgetUsd != null ? cost.budgetUsd : "∞"}${cost.remainingUsd != null ? `, $${cost.remainingUsd.toFixed(2)} left` : ""}. Our server: up to ${e.pagesFetchedByOurServer.max} pages + ${e.imagesFetchedByOurServer.max} images.`,
      { confirmLabel: "Start this wave", cancelLabel: "Cancel" });
    if (!ok) return;
    if (s) { s.textContent = "Starting…"; s.classList.remove("is-error"); }
    els.progress.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await post("/api/part-photo-backfill/wave", { skus: plan.skus });
      await load(true);
    } catch (err) {
      els.progress.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      say(err.message, true);
    }
  }
  // The benchmark: show the exact 10-part dry-run plan, the sources' status
  // and the baseline, then send back the very list shown.
  async function startBenchmark() {
    const s = els.progress.querySelector("[data-status]");
    const say = (t, bad) => { if (s) { s.textContent = t; s.classList.toggle("is-error", !!bad); } };
    say("Building the benchmark plan…");
    let plan;
    try {
      const r = await fetch("/api/part-photo-backfill/benchmark-plan", { cache: "no-store" });
      plan = await r.json();
      if (!r.ok || !plan.ok) throw new Error((plan.errors && plan.errors[0]) || `HTTP ${r.status}`);
    } catch (err) { say(`Couldn't build the plan: ${err.message}`, true); return; }
    say("");
    if (plan.problems && plan.problems.length) { say(`Benchmark list refused: ${plan.problems.join("; ")}`, true); return; }
    if (!plan.skus.length) { say("Nothing to benchmark.", true); return; }
    const e = plan.estimate;
    const list = plan.rows.map((r) => `${r.sku} (${r.kind}${r.manufacturer ? ", " + r.manufacturer : ""}${r.live ? ", live photo — compared, not touched" : ""}) — ${r.description}`).join("\n");
    const sources = (plan.fastSources || []).map((x) => `${x.id}: ${x.status}${x.note ? ` (${x.note})` : ""}`).join("\n");
    const ok = await window.pjlDialog.confirm(
      `Run the fast-path benchmark on these ${plan.counts.total} already-processed parts (${plan.counts.branded} branded, ${plan.counts.generic} generic)? DRY RUN: nothing is saved — no photo, no review card, no link changes. Auto-approve is OFF.\n\n${list}\n\nFast-path sources:\n${sources}\n\nWorst case: ${e.apiCalls.max} Claude calls (${e.finderCalls.max} finder, ${e.verifyCalls.max} vision, ${e.compareCalls.max} compare), up to ${e.webSearches.max} web searches, and up to ${e.pagesFetchedByOurServer.max} pages + ${e.imagesFetchedByOurServer.max} images fetched by our server.`,
      { confirmLabel: "Run the benchmark", cancelLabel: "Cancel" });
    if (!ok) return;
    if (s) { s.textContent = "Starting…"; s.classList.remove("is-error"); }
    els.progress.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await post("/api/part-photo-backfill/benchmark", { skus: plan.skus });
      await load(true);
    } catch (err) {
      els.progress.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      say(err.message, true);
    }
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
    else if (b.dataset.act === "start-wave") startWave();
    else if (b.dataset.act === "benchmark") startBenchmark();
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
  // The quality gate's verdict on the picture itself (Patrick, Sep 28 2026):
  // the SOURCE dimensions and the grade, so a thumbnail never looks like a
  // photo. Older candidates carry only the stored 1200-copy dimensions.
  function qualityHtml(c) {
    const src = c.source || {};
    const up = src.upgradedFrom ? " · larger than the page's thumbnail" : "";
    if (c.quality && c.imageSource) {
      const q = c.quality;
      const dims = `${c.imageSource.width}×${c.imageSource.height} source`;
      if (q.grade === "good") return `<p class="pr-quality is-good">✓ ${esc(dims)} · high resolution${up}</p>`;
      if (q.grade === "ok") return `<p class="pr-quality is-ok">✓ ${esc(dims)} · acceptable resolution${up}</p>`;
      return `<p class="pr-quality is-low">! Low quality — review needed: ${esc(q.reason)}${up}</p>`;
    }
    if (c.width && c.height) {
      const longest = Math.max(c.width, c.height);
      return `<p class="pr-quality ${longest < 800 ? "is-low" : "is-unknown"}">${longest < 800 ? "! " : ""}${c.width}×${c.height} stored · saved before the quality gate${longest < 800 ? " — low resolution" : ""}</p>`;
    }
    return "";
  }
  function candHtml(card, c, i, selected) {
    const src = c.source || {};
    const href = safeHref(src.pageUrl);
    const via = src.pass === 0 || src.pass === "0" ? "fast path" : (src.pass ? PASS_LABEL[src.pass] || "" : "");
    return `<figure class="pr-cand${selected ? " is-selected" : ""}" data-hash="${esc(c.hash)}" data-idx="${i}">
      <button type="button" class="pr-cand-img" data-act="zoom" data-hash="${esc(c.hash)}" aria-label="Photo ${i + 1}, open full size">
        <img src="${img(c.hash, 480)}" alt="Candidate photo ${i + 1} for ${esc(card.part.description)}" loading="lazy">
        <span class="pr-cand-n" aria-hidden="true">${i + 1}</span>
      </button>
      <figcaption>
        <p class="pr-src">${esc(src.domain || "unknown site")}${src.official ? ' <span class="pr-official">official</span>' : ""}${via ? ` · ${esc(via)}` : ""}${href ? ` · <a href="${href}" target="_blank" rel="noopener noreferrer">Open page ↗</a>` : ""}</p>
        ${qualityHtml(c)}
        ${checksHtml(c.checks)}
      </figcaption>
      ${card.queue === "autoApproved" ? "" : `<button type="button" class="pp-btn pp-btn-primary pr-approve" data-act="approve" data-hash="${esc(c.hash)}">Approve this photo</button>`}
    </figure>`;
  }
  const TIER_LABEL = { tbd: "To be determined", not_confident: "Not confident", needs_research: "Needs research", confident: "Auto-approved", approved: "Approved" };

  // "Pages our server checked": what happened on each product page the
  // finder named — the reason "no reliable photo" is never a mystery.
  function pagesHtml(pages) {
    if (!pages || !pages.length) return "";
    const short = (u) => { const s = String(u || "").replace(/^https?:\/\/(www\.)?/, ""); return s.length > 72 ? s.slice(0, 69) + "…" : s; };
    const what = (p) => p.fetch !== "ok" ? (p.note || "fetch failed")
      : `${p.images} image${p.images === 1 ? "" : "s"} · part # ${p.partNumber || "?"}${p.note ? ` · ${p.note}` : ""}`;
    return `<div class="pr-pages"><span class="pr-pages-title">Pages our server checked</span><ul>${pages.map((p) => {
      const href = safeHref(p.url);
      const label = href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(short(p.url))}</a>` : esc(short(p.url));
      return `<li class="${p.fetch !== "ok" ? "is-failed" : p.images ? "is-ok" : "is-empty"}">${label}${p.official ? ' <span class="pr-official">official</span>' : ""} — ${esc(what(p))}</li>`;
    }).join("")}</ul></div>`;
  }

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
    const reason = `<div class="pr-reason is-${esc(card.tier)}"><b>${TIER_LABEL[card.tier] || card.tier}</b>${card.reason ? ` — ${esc(card.reason)}` : ""}</div>`
      + pagesHtml(card.pages);
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
    const head = state.queue === "quality" ? qualityPanelHtml(d) : "";
    if (!items.length) { els.list.innerHTML = head + `<p class="pp-empty">${q.empty}</p>`; return; }
    els.list.innerHTML = head + `<p class="pr-pos">${state.cur + 1} of ${items.length}</p>` + items.map((it, i) =>
      state.queue === "fittings" ? fittingCardHtml(it, i) : state.queue === "quality" ? qualityCardHtml(it, i) : reviewCardHtml(it, i, state.queue)).join("");
  }

  // ---- Quality upgrade of live photos (Patrick, Sep 28 2026) --------------
  // The plan: how many live photos under the threshold can be replaced by a
  // larger copy of the SAME picture from the same page (deterministic), and
  // how many need a look. Before/after side by side; apply sends back the
  // exact list shown.
  function qualityPanelHtml(d) {
    const qp = d.qualityPlan || {};
    const plan = qp.plan, c = qp.counts || {};
    const ups = qp.upgrades || [];
    const status = !plan ? "No plan built yet."
      : plan.status === "building" || plan.building ? `Building… ${plan.done} of ${plan.total} photos checked.`
      : `Plan ${esc(plan.id)} · ${plan.total} live photo${plan.total === 1 ? "" : "s"} under 800 px · <b>${c.applicable || 0}</b> can be upgraded deterministically · <b>${c.openReview || 0}</b> need a look${c.applied ? ` · ${c.applied} already applied` : ""}`;
    const rows = ups.map((r) => `<tr>
      <td><span class="pp-mono">${r.skus.map(esc).join(", ")}</span><br><small>${esc(r.label)}</small></td>
      <td><a class="pr-q-img" href="${img(r.current.hash, 1200)}" target="_blank" rel="noopener"><img src="${img(r.current.hash, 480)}" alt=""></a><br>${r.current.longest}px · ${esc(r.current.domain || "")}</td>
      <td><a class="pr-q-img" href="${img(r.upgrade.hash, r.upgrade.sizes && r.upgrade.sizes.includes(2000) ? 2000 : 1200)}" target="_blank" rel="noopener"><img src="${img(r.upgrade.hash, 480)}" alt=""></a><br>${r.upgrade.source.width}×${r.upgrade.source.height} · ${esc(r.upgrade.quality.grade)} · match ${r.upgrade.similarity}</td>
      <td>${esc(r.current.approvedBy || "")}<br><small>kept as is</small></td>
    </tr>`).join("");
    const building = plan && (plan.status === "building" || plan.building);
    return `<section class="pr-quality">
      <h3>Quality upgrade of live photos</h3>
      <p class="pr-q-status">${status}</p>
      <div class="pr-controls">
        <button type="button" class="pp-btn" data-act="quality-plan"${building ? " disabled" : ""}>${plan ? "Rebuild the plan" : "Build the plan"} (reads each photo's product page)</button>
        ${ups.length ? `<button type="button" class="pp-btn pp-btn-primary" data-act="quality-apply">Apply the ${ups.length} deterministic upgrade${ups.length === 1 ? "" : "s"}</button>` : ""}
        <span class="pp-panel-status" data-status aria-live="polite"></span>
      </div>
      ${ups.length ? `<div class="pr-bench-scroll"><table class="pr-q-table"><thead><tr><th>Part(s)</th><th>Today (live)</th><th>Same picture, larger</th><th>Approval (unchanged)</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    </section>`;
  }
  function qualityCardHtml(r, idx) {
    const isCur = idx === state.cur;
    const tried = (r.tried || []).filter((t) => t.width).map((t) => `${t.width}×${t.height}${t.note ? ` — ${esc(t.note)}` : ""}`).join("; ");
    const href = safeHref(r.current.pageUrl);
    return `<article class="pr-card${isCur ? " is-current" : ""}" data-idx="${idx}" data-group="${esc(r.groupId)}" tabindex="-1" aria-label="${esc(r.label)}">
      <header class="pr-card-head"><div class="pr-part">
        <div class="pp-desc">${esc(r.label)}</div>
        <div class="pp-meta"><span class="pp-mono">${r.skus.map(esc).join(", ")}</span> · live photo ${r.current.longest}px${r.current.domain ? ` · ${esc(r.current.domain)}` : ""}${href ? ` · <a href="${href}" target="_blank" rel="noopener noreferrer">Open page ↗</a>` : ""}</div>
        <div class="pr-reason is-tbd"><b>Needs a look</b> — ${esc(r.reason)}${tried ? `<br><small>Tried: ${tried}</small>` : ""}</div>
      </div></header>
      <div class="pr-cands is-single"><figure class="pr-cand"><button type="button" class="pr-cand-img" data-act="zoom" data-hash="${esc(r.current.hash)}" aria-label="Current photo, open full size"><img src="${img(r.current.hash, 480)}" alt="Current live photo for ${esc(r.label)}" loading="lazy"></button><figcaption><p class="pr-quality is-low">! ${r.current.longest}px stored — below the 800 px threshold</p></figcaption></figure></div>
      <footer class="pr-actions">
        <button type="button" class="pp-btn" data-act="quality-keep">Keep as is</button>
        <span class="pp-panel-status" data-status aria-live="polite"></span>
      </footer>
    </article>`;
  }
  async function qualityAction(kind, card) {
    const s = (card || els.list).querySelector("[data-status]");
    const say = (t, bad) => { if (s) { s.textContent = t; s.classList.toggle("is-error", !!bad); } };
    if (kind === "plan") {
      const ok = await window.pjlDialog.confirm("Build the quality-upgrade plan? Our server re-reads the product page of every live photo under 800 px and measures any larger copy of the same picture. Nothing is replaced by this step.", { confirmLabel: "Build the plan", cancelLabel: "Cancel" });
      if (!ok) return;
      say("Building…");
      try { await post("/api/part-photo-quality/plan", {}); await load(true); } catch (err) { say(err.message, true); }
      return;
    }
    if (kind === "apply") {
      const ups = (state.data.qualityPlan && state.data.qualityPlan.upgrades) || [];
      const list = ups.map((r) => `${r.skus.join(", ")} — ${r.current.longest}px → ${r.upgrade.source.width}×${r.upgrade.source.height} (${r.upgrade.quality.grade})`).join("\n");
      const ok = await window.pjlDialog.confirm(`Replace ${ups.length} live photo${ups.length === 1 ? "" : "s"} with the larger copy of the same picture? Part match, fitting, approval and confidence stay exactly as they are; the old image is kept in the history.\n\n${list}`, { confirmLabel: "Apply the upgrades", cancelLabel: "Cancel" });
      if (!ok) return;
      say("Applying…");
      try { const out = await post("/api/part-photo-quality/upgrade", { hashes: ups.map((r) => r.upgrade.hash) }); say(`Upgraded ${out.applied.length}${out.skipped.length ? `, skipped ${out.skipped.length}` : ""}.`); await load(true); } catch (err) { say(err.message, true); }
      return;
    }
    if (kind === "keep" && card) {
      await act(card, () => post(`/api/part-photo-quality/review/${encodeURIComponent(card.dataset.group)}`, { action: "keep" }), "Saving…");
    }
  }
  els.list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act^=\"quality-\"]");
    if (!b || state.busy) return;
    e.stopPropagation();
    qualityAction(b.dataset.act.replace("quality-", ""), b.closest(".pr-card"));
  }, true);
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
