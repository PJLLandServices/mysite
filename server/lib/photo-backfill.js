// Photo backfill runner — works through the catalog one SKU at a time,
// step by step, saving after every step (P-PJL-35 M3).
//
// Per SKU:  find → check → map (branded) → verify → cross (generic) → tier → record
//   find    AI web search: product page + image URL candidates, official
//           manufacturer site first, then SiteOne / Central, then (generic
//           only) the open web.
//   check   OUR server downloads each page and image: the part number must
//           be in the page's visible product text (photo-evidence); generic
//           pages are matched against the spec; images are stored resize-only
//           as candidates (never live on their own).
//   map     branded, when our number is a distributor code the official page
//           doesn't print: a supplier page must show our code AND the
//           manufacturer's model in visible text (supplierCodeMapping).
//   verify  a separate AI vision call per candidate — image bytes + our spec,
//           nothing else.
//   cross   generic fittings: a second source from a different domain must
//           show the same fitting.
//   tier    photo-evidence.tierFor — code, not the model.
//   record  part-photos.recordAiResult — live only if Confident AND the run
//           has auto-approve on; never overwrites a live photo.
//
// Stop/restart safety: state lives in server/data/part-photos-backfill.json,
// written atomically after every completed step. A step that was running
// when the process stopped simply runs again; every step is idempotent
// (content-addressed images, recordAiResult skips live photos). Temporary
// failures (rate limits, 5xx, timeouts) retry with backoff; after
// maxAttempts, or on a permanent failure, the SKU is marked "error" with the
// reason and can be retried on its own.

const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { writeJsonAtomic, serialize } = require("./atomic-json");
const ev = require("./photo-evidence");

const STEPS = ["queued", "find", "check", "map", "verify", "cross", "tier", "record", "done"];
const BRAND_ORDER = ["hunter", "rainbird", "netafim", "oilcreek", "dawn", "blulock", "watts"];

function isTransient(err) {
  if (!err) return false;
  if (err.permanent) return false;
  if (err.transient) return true;
  const status = Number(err.status || err.statusCode || 0);
  if (status === 429 || status === 408 || status === 409 || status >= 500) return true;
  if (["AbortError", "TimeoutError", "APIConnectionError", "APIConnectionTimeoutError"].includes(err.name)) return true;
  return ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_SOCKET"].includes(err.code);
}

function createBackfill({
  dataDir,
  store,             // part-photos store (createPartPhotos)
  ai,                // photo-ai (createPhotoAI) — or a fake in tests
  getParts,          // () => the live merged catalog { sku: part }
  manufacturers = [],// [{ key, label }]
  fetchPage,         // (url) => { html, finalUrl }
  fetchImage,        // (url) => { buffer, finalUrl }
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  concurrency = 2,
  maxAttempts = 3,
  backoffMs = [5_000, 30_000, 120_000],
  log = () => {}
}) {
  const FILE = path.join(dataDir, "part-photos-backfill.json");
  const labelOf = Object.fromEntries(manufacturers.map((m) => [m.key, m.label]));
  let state = null;
  let running = 0;
  let wake = null;

  async function load() {
    if (state) return state;
    try { state = JSON.parse(await fs.readFile(FILE, "utf8")); }
    catch (err) {
      if (err.code !== "ENOENT") throw new Error(`part-photos-backfill.json is unreadable (${err.message}) — refusing to treat it as empty.`);
      state = { run: null, history: [] };
    }
    // A step that was running when the process stopped runs again.
    if (state.run) for (const it of Object.values(state.run.items)) delete it.inFlight;
    return state;
  }
  function save() {
    const snapshot = JSON.parse(JSON.stringify(state));
    return serialize(FILE, async () => { await fs.mkdir(dataDir, { recursive: true }); await writeJsonAtomic(FILE, snapshot); });
  }

  function enrich(part) {
    const supplierSkus = Object.values(part.supplierPrices || {}).map((v) => v && v.supplierSku).filter(Boolean);
    return { ...part, manufacturerLabel: labelOf[part.manufacturer] || "", supplierSkus: [...new Set(supplierSkus)] };
  }
  function kindOf(part) { return ev.MANUFACTURER_DOMAINS[part.manufacturer] ? "branded" : "generic"; }
  function isLive(part) { return !!(part && part.photoState === "verified"); }

  // ---- control ---------------------------------------------------------
  async function start({ skus = null, autoApprove = false, label = "" } = {}) {
    await load();
    if (state.run && ["running", "paused"].includes(state.run.status)) throw new Error("A backfill run is already in progress — pause or finish it first.");
    const parts = getParts() || {};
    const pick = (skus || Object.keys(parts)).filter((s) => parts[s] && !isLive(parts[s]));
    const rank = (p) => { const i = BRAND_ORDER.indexOf(p.manufacturer); return i < 0 ? 99 : i; };
    const order = pick.sort((a, b) => rank(parts[a]) - rank(parts[b]) || a.localeCompare(b));
    if (state.run) state.history = [...(state.history || []), summary(state.run)].slice(-20);
    state.run = {
      id: "BF-" + new Date(now()).toISOString().replace(/[-:T]/g, "").slice(0, 12) + "-" + crypto.randomBytes(2).toString("hex"),
      label, status: "running", createdAt: new Date(now()).toISOString(),
      options: { autoApprove: !!autoApprove },
      order,
      items: Object.fromEntries(order.map((s) => [s, { step: "queued", attempts: 0, nextAt: 0, lastError: null, work: {}, result: null, usage: { in: 0, out: 0, searches: 0 } }])),
      usage: { in: 0, out: 0, searches: 0 }
    };
    await save();
    log({ action: "backfill.start", runId: state.run.id, count: order.length, autoApprove: !!autoApprove });
    kick();
    return status();
  }
  async function pause() {
    await load();
    if (state.run && state.run.status === "running") { state.run.status = "paused"; await save(); }
    return status();
  }
  async function resume() {
    await load();
    if (state.run && state.run.status === "paused") { state.run.status = "running"; await save(); }
    if (state.run && state.run.status === "running") kick();
    return status();
  }
  // Retry one SKU that ended in "error" (from the step it failed on).
  async function retry(sku) {
    await load();
    const it = state.run && state.run.items[sku];
    if (!it || it.step !== "error") throw new Error("That SKU isn't in an error state.");
    it.step = it.failedStep || "queued"; it.attempts = 0; it.nextAt = 0; it.lastError = null;
    if (state.run.status === "done") state.run.status = "running";
    await save();
    kick();
    return status();
  }

  // ---- the loop ----------------------------------------------------------
  let pumping = null;
  function kick() {
    if (wake) { wake(); wake = null; }
    if (!pumping) pumping = pump().finally(() => { pumping = null; });
    return pumping;
  }
  function nextRunnable() {
    const r = state.run;
    if (!r || r.status !== "running") return null;
    const t = now();
    for (const sku of r.order) {
      const it = r.items[sku];
      if (it.inFlight || it.step === "done" || it.step === "error") continue;
      if (it.nextAt > t) continue;
      return sku;
    }
    return null;
  }
  function earliestWait() {
    const r = state.run;
    let min = Infinity;
    for (const sku of r.order) { const it = r.items[sku]; if (!it.inFlight && it.step !== "done" && it.step !== "error") min = Math.min(min, it.nextAt); }
    return min;
  }
  async function pump() {
    await load();
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);
    const r = state.run;
    if (r && r.status === "running" && r.order.every((s) => ["done", "error"].includes(r.items[s].step))) {
      r.status = "done"; r.finishedAt = new Date(now()).toISOString();
      await save();
      log({ action: "backfill.done", runId: r.id });
    }
  }
  async function worker() {
    for (;;) {
      const r = state.run;
      if (!r || r.status !== "running") return;
      const sku = nextRunnable();
      if (!sku) {
        const wait = earliestWait();
        if (wait === Infinity) return; // nothing left for this worker
        await sleep(Math.max(0, wait - now()));
        continue;
      }
      const it = r.items[sku];
      it.inFlight = true;
      try {
        await runStep(sku, it);
        it.attempts = 0;
      } catch (err) {
        it.attempts += 1;
        it.lastError = String(err && err.message || err).slice(0, 300);
        if (isTransient(err) && it.attempts < maxAttempts) {
          it.nextAt = now() + (backoffMs[it.attempts - 1] || backoffMs[backoffMs.length - 1]);
        } else {
          it.failedStep = it.step;
          it.step = "error";
        }
        log({ action: "backfill.step-error", sku, step: it.failedStep || it.step, error: it.lastError, transient: isTransient(err) });
      } finally {
        delete it.inFlight;
        await save();
      }
    }
  }

  // ---- one step ----------------------------------------------------------
  async function runStep(sku, it) {
    const r = state.run;
    const parts = getParts() || {};
    const raw = parts[sku];
    if (!raw) { it.result = { tier: "skipped", reason: "No longer in the catalog." }; it.step = "done"; return; }
    const part = enrich(raw);
    const kind = kindOf(part);
    const usage = (u) => {
      const add = { in: u.input_tokens || 0, out: u.output_tokens || 0, searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0 };
      for (const k of Object.keys(add)) { it.usage[k] += add[k]; r.usage[k] += add[k]; }
    };

    if (it.step === "queued") {
      if (isLive(raw)) { it.result = { tier: "skipped", reason: "Already has a live photo." }; it.step = "done"; return; }
      it.step = "find";
      return;
    }

    if (it.step === "find") {
      let found = { identified: null, candidates: [], notes: [] };
      for (const pass of ai.passesFor(part)) {
        const res = await ai.find(part, pass, usage);
        const cands = (res.candidates || []).filter((c) => /^https:\/\//i.test(c.pageUrl || "") && /^https:\/\//i.test(c.imageUrl || "")).slice(0, 3);
        found.notes.push(`pass ${pass}: ${res.notes || ""}`.trim());
        if (res.manufacturerPartNumber) found.identified = { manufacturer: res.manufacturer || part.manufacturerLabel, manufacturerPartNumber: res.manufacturerPartNumber };
        if (cands.length) {
          found.candidates = cands.map((c) => ({
            pageUrl: c.pageUrl, imageUrl: c.imageUrl, partNumberAsShown: c.partNumberAsShown || "", pass,
            domain: ev.hostOf(c.pageUrl), official: ev.isOfficialManufacturerPage(c.pageUrl, part.manufacturer)
          }));
          break;
        }
      }
      it.work.found = found;
      it.step = found.candidates.length ? "check" : "tier";
      return;
    }

    if (it.step === "check") {
      const checked = [];
      const spec = ev.parseSpec(part);
      const ours = [part.partNumber, part.sku, ...part.supplierSkus];
      const theirs = it.work.found.identified ? [it.work.found.identified.manufacturerPartNumber] : [];
      for (const c of it.work.found.candidates) {
        const entry = { source: { pageUrl: c.pageUrl, imageUrl: c.imageUrl, domain: c.domain, pass: c.pass, official: c.official }, notes: [] };
        let page;
        try { page = await fetchPage(c.pageUrl); }
        catch (err) { if (isTransient(err)) throw err; entry.notes.push(`page: ${err.message}`); checked.push(entry); continue; }
        entry.source.pageUrl = page.finalUrl || c.pageUrl;
        // The part number must be in the VISIBLE product text of the page
        // we downloaded. Ours (or a supplier's) → pass. Only the
        // manufacturer's number the finder named → "unknown": the page may
        // be right, but nothing ties it to OUR part, so Patrick looks.
        let pn = ev.partNumberOnPage(page.html, ours);
        if (pn.result !== "pass" && theirs.length) {
          const t = ev.partNumberOnPage(page.html, theirs);
          if (t.result === "pass") pn = { result: "unknown", reason: "Only the manufacturer's number (not ours) is on the page.", matched: t.matched };
        }
        entry.partNumber = pn;
        entry.manufacturerNumberOnPage = theirs.length ? ev.partNumberOnPage(page.html, theirs).result === "pass" : false;
        if (kind === "generic") entry.specMatch = ev.pageMatchesSpec(page.html, spec);
        try {
          const img = await fetchImage(c.imageUrl);
          const saved = await store.saveCandidateImage(img.buffer);
          Object.assign(entry, saved);
          entry.source.imageUrl = img.finalUrl || c.imageUrl;
        } catch (err) {
          if (isTransient(err)) throw err;
          entry.notes.push(`image: ${err.message}`);
        }
        checked.push(entry);
      }
      it.work.checked = checked;
      it.step = kind === "branded" ? "map" : "verify";
      return;
    }

    // Branded only: our number isn't on the official page, but the
    // manufacturer's model is. Look for a supplier/manufacturer page that
    // shows BOTH in visible product text; if one does, the official page's
    // model number stands for ours. Otherwise nothing changes (TBD).
    if (it.step === "map") {
      const theirs = it.work.found && it.work.found.identified ? [it.work.found.identified.manufacturerPartNumber] : [];
      const needs = (it.work.checked || []).filter((c) => c.source.official && c.manufacturerNumberOnPage && c.partNumber && c.partNumber.result === "unknown");
      if (needs.length && theirs.length && !it.work.mapping) {
        const ours = [part.partNumber, part.sku, ...part.supplierSkus];
        const res = await ai.find(part, 2, usage);
        let mapping = null;
        for (const c of (res.candidates || []).slice(0, 3)) {
          if (!/^https:\/\//i.test(c.pageUrl || "")) continue;
          let page;
          try { page = await fetchPage(c.pageUrl); }
          catch (err) { if (isTransient(err)) throw err; continue; }
          const m = ev.supplierCodeMapping(page.html, page.finalUrl || c.pageUrl, ours, theirs, part.manufacturer);
          if (m.result === "pass") { mapping = m; break; }
        }
        it.work.mapping = mapping || { result: "unknown", reason: "No supplier page shows our number next to the manufacturer's." };
      }
      if (it.work.mapping && it.work.mapping.result === "pass") {
        for (const c of needs) c.partNumber = { result: "pass", reason: `Official page shows ${it.work.mapping.theirs}; ${it.work.mapping.reason}`, matched: it.work.mapping.theirs, mappedVia: it.work.mapping.pageUrl };
      }
      it.step = "verify";
      return;
    }

    if (it.step === "verify") {
      for (const c of it.work.checked) {
        if (!c.hash || c.vision) continue; // done before a restart, or no image
        const bytes = await store.readCandidateImage(c.hash, 1200);
        c.vision = await ai.verify(part, bytes, "image/webp", usage);
        await save(); // one verified candidate is progress worth keeping
      }
      it.step = kind === "generic" ? "cross" : "tier";
      return;
    }

    if (it.step === "cross") {
      const cs = it.work.checked.filter((c) => c.hash);
      const good = (c) => c.specMatch && c.specMatch.result === "pass" && ev.visionSummary(c.vision).result !== "fail";
      const a = cs.find((c) => good(c) && ev.visionSummary(c.vision).result === "pass") || cs.find(good);
      const b = a && cs.find((c) => c !== a && c.source.domain !== a.source.domain && good(c));
      if (!a) it.work.cross = { result: "unknown", reason: "No candidate matched the spec." };
      else if (!b) it.work.cross = { result: "unknown", reason: "No second, independent source." };
      else {
        const [ia, ib] = await Promise.all([store.readCandidateImage(a.hash, 1200), store.readCandidateImage(b.hash, 1200)]);
        const cmp = await ai.compare(part, ia, ib, "image/webp", usage);
        it.work.cross = { result: cmp.result, reason: cmp.reason, against: b.source.domain };
      }
      it.step = "tier";
      return;
    }

    if (it.step === "tier") {
      const cs = (it.work.checked || []).filter((c) => c.hash);
      const scored = cs.map((c) => ({ c, t: ev.tierFor({ kind, hasCandidate: true, partNumber: c.partNumber, vision: c.vision, specMatch: c.specMatch, crossSource: it.work.cross }) }));
      const order = { confident: 0, tbd: 1, not_confident: 2 };
      scored.sort((x, y) => order[x.t.tier] - order[y.t.tier] || (y.c.source.official ? 1 : 0) - (x.c.source.official ? 1 : 0) || x.c.source.pass - y.c.source.pass);
      const best = scored[0];
      const t = best ? best.t : ev.tierFor({ kind, hasCandidate: false });
      const notes = (it.work.found && it.work.found.notes || []).join(" ");
      it.work.tier = {
        tier: t.tier,
        reason: best ? t.reason : `${t.reason} ${notes}`.trim(),
        chosenHash: best ? best.c.hash : null,
        candidates: scored.map(({ c, t: ct }) => ({ hash: c.hash, width: c.width, height: c.height, source: c.source, tier: ct.tier,
          checks: { partNumber: c.partNumber || null, specMatch: c.specMatch || null, vision: c.vision || null, crossSource: kind === "generic" ? it.work.cross || null : null } }))
      };
      it.step = "record";
      return;
    }

    if (it.step === "record") {
      const t = it.work.tier;
      const chosen = t.candidates.findIndex((c) => c.hash === t.chosenHash);
      const res = await store.recordAiResult(sku, raw, {
        tier: t.tier, kind, reason: t.reason, runId: r.id,
        identified: it.work.found && it.work.found.identified, candidates: t.candidates, chosen
      }, { autoApprove: r.options.autoApprove });
      it.result = { tier: t.tier, reason: t.reason, live: !!res.live, skipped: res.skipped || null, groupId: res.groupId || null };
      it.step = "done";
      return;
    }
    throw Object.assign(new Error(`Unknown step "${it.step}"`), { permanent: true });
  }

  // ---- same-fitting grouping (after a run) --------------------------------
  // Auto-link only same manufacturer + same manufacturer part # on official
  // pages; everything else becomes a "Fittings to confirm" proposal.
  async function groupingProposals() {
    await load();
    const r = state.run;
    if (!r) return { autoLinked: [], proposals: [] };
    const parts = getParts() || {};
    const facts = [];
    for (const sku of r.order) {
      const it = r.items[sku];
      const chosen = it.work && it.work.tier && it.work.tier.candidates.find((c) => c.hash === it.work.tier.chosenHash);
      facts.push({
        sku, part: parts[sku], manufacturer: parts[sku] && parts[sku].manufacturer,
        manufacturerPartNumber: it.work.found && it.work.found.identified && it.work.found.identified.manufacturerPartNumber,
        officialPage: !!(chosen && chosen.source.official && it.work.checked && it.work.checked.find((c) => c.hash === chosen.hash && c.manufacturerNumberOnPage))
      });
    }
    const autoLinked = [], proposals = [];
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        if (!facts[i].part || !facts[j].part) continue;
        const d = ev.groupingDecision(facts[i], facts[j]);
        if (d.action === "auto-link") autoLinked.push({ a: facts[i].sku, b: facts[j].sku, reason: d.reason });
        else if (d.action === "propose") proposals.push({ a: facts[i].sku, b: facts[j].sku, reason: d.reason });
      }
    }
    return { autoLinked, proposals };
  }

  // Apply the grouping: auto-links go through the store (audit-logged);
  // proposals are kept on the run for the "Fittings to confirm" queue.
  // Target = the fitting whose photo Patrick approved, else one with a live
  // photo, else the first of the pair.
  async function applyGrouping() {
    const { autoLinked, proposals } = await groupingProposals();
    const applied = [];
    for (const pair of autoLinked) {
      const parts = getParts() || {};
      const weight = (p) => !isLive(p) ? 0 : String(p.photo.approvedBy || "").startsWith("auto:") ? 1 : 2;
      const [target, mover] = weight(parts[pair.b]) > weight(parts[pair.a]) ? [pair.b, pair.a] : [pair.a, pair.b];
      const res = await store.autoLinkSameFitting(mover, parts[mover], target, { reason: pair.reason });
      if (res.propose) proposals.push({ a: pair.a, b: pair.b, reason: "Same manufacturer part number, but both already have different live photos — pick one." });
      else applied.push({ sku: mover, into: target, ...res });
    }
    state.run.grouping = { at: new Date(now()).toISOString(), applied, proposals };
    await save();
    log({ action: "backfill.grouping", runId: state.run.id, autoLinked: applied.length, proposals: proposals.length });
    return state.run.grouping;
  }

  // The 15-part calibration sample (8 branded, 7 generic), not yet live.
  function calibrationSkus() {
    const parts = getParts() || {};
    return ev.pickCalibrationSample(Object.values(parts), { branded: 8, generic: 7, isLive }).skus;
  }

  // ---- progress -----------------------------------------------------------
  function summary(run) {
    const c = { total: run.order.length, queued: 0, inProgress: 0, done: 0, error: 0, live: 0, review: 0, noReliable: 0, skipped: 0 };
    for (const sku of run.order) {
      const it = run.items[sku];
      if (it.step === "done") {
        c.done++;
        const t = it.result && it.result.tier;
        if (t === "skipped" || (it.result && it.result.skipped)) c.skipped++;
        else if (it.result && it.result.live) c.live++;
        else if (t === "not_confident") c.noReliable++;
        else c.review++;
      } else if (it.step === "error") c.error++;
      else if (it.step === "queued") c.queued++;
      else c.inProgress++;
    }
    return { id: run.id, label: run.label, status: run.status, autoApprove: run.options.autoApprove, createdAt: run.createdAt, finishedAt: run.finishedAt || null, counts: c, usage: run.usage };
  }
  // Whole-catalog view (Patrick's progress panel): every SKU is Live,
  // Review needed, No reliable photo or Not processed yet.
  function catalogProgress() {
    const parts = getParts() || {};
    const c = { total: 0, live: 0, review: 0, noReliable: 0, notProcessed: 0 };
    for (const p of Object.values(parts)) {
      c.total++;
      if (p.photoState === "verified") c.live++;
      else if (p.photoState === "tbd" || p.photoState === "changed") c.review++;
      else if (p.photoState === "not_confident") c.noReliable++;
      else c.notProcessed++;
    }
    return c;
  }
  function status() {
    return { run: state && state.run ? summary(state.run) : null, catalog: catalogProgress() };
  }
  async function idle() {
    await load();
    while (pumping) await pumping;
  }

  return { load, start, pause, resume, retry, status, idle, kick, groupingProposals, applyGrouping, calibrationSkus, catalogProgress, _state: () => state };
}

module.exports = { createBackfill, isTransient, STEPS };
