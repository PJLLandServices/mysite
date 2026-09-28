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
const pq = require("./photo-quality");
// Fast Product Lookup (Patrick, Sep 28 2026): before the finder, the
// supplier's own search + product page (photo-fast-lookup). Its pages are
// candidates like any other; the finder runs only when it falls short.
// Image-quality gate (same day): every downloaded image is measured before
// it is saved; a larger member of the same picture is preferred over a
// thumbnail URL; low quality can never back a Confident result.

const STEPS = ["queued", "find", "check", "map", "verify", "cross", "tier", "record", "done"];
const BRAND_ORDER = ["hunter", "rainbird", "netafim", "oilcreek", "dawn", "blulock", "watts"];

// "Pages checked: hunterirrigation.com (official) — HTTP 404; siteone.com —
// 2 images, part # pass." One readable line for the reason field.
function pageDiagnosticsLine(pages) {
  if (!pages || !pages.length) return "";
  const one = (p) => {
    const where = `${String(p.domain || "?").replace(/^www\./, "")}${p.official ? " (official)" : ""}`;
    if (p.fetch !== "ok") return `${where} — ${p.note || "fetch failed"}`;
    const ok = `${p.images} image${p.images === 1 ? "" : "s"}, part # ${p.partNumber || "?"}`;
    return `${where} — ${p.note ? p.note : ok}`;
  };
  return `Pages checked: ${pages.map(one).join("; ")}.`;
}

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
  fastLookup = null, // photo-fast-lookup (createFastLookup) — null = finder only
  getParts,          // () => the live merged catalog { sku: part }
  manufacturers = [],// [{ key, label }] or a function returning them
  afterRun = null,   // async (run) => {} — called once when a run finishes (grouping, catalog rebuild)
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
  const labelOf = (key) => {
    const list = typeof manufacturers === "function" ? manufacturers() || [] : manufacturers;
    const m = list.find((x) => x && x.key === key);
    return m ? (m.label || m.name || "") : "";
  };
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
    // A step that was running when the process stopped runs again — but
    // only when an admin presses Resume. Nothing runs on startup or deploy.
    if (state.run) for (const it of Object.values(state.run.items)) delete it.inFlight;
    if (state.run && state.run.status === "running") {
      state.run.status = "paused";
      state.run.interruptedAt = new Date(now()).toISOString();
    }
    return state;
  }
  function save() {
    const snapshot = JSON.parse(JSON.stringify(state));
    return serialize(FILE, async () => { await fs.mkdir(dataDir, { recursive: true }); await writeJsonAtomic(FILE, snapshot); });
  }

  // The part as the run sees it. A blank catalog manufacturer whose
  // description names a known brand gets that brand PROPOSED for the
  // branded path (photo-evidence.proposedBrand); the catalog row itself is
  // never changed, and the official page still has to prove the product.
  function enrich(part) {
    const supplierSkus = Object.values(part.supplierPrices || {}).map((v) => v && v.supplierSku).filter(Boolean);
    const manufacturer = ev.effectiveManufacturer(part);
    const proposed = !String(part.manufacturer || "").trim() && !!manufacturer;
    return { ...part, manufacturer, catalogManufacturer: part.manufacturer || "", manufacturerProposed: proposed, manufacturerLabel: labelOf(manufacturer), supplierSkus: [...new Set(supplierSkus)] };
  }
  function kindOf(part) { return ev.MANUFACTURER_DOMAINS[ev.effectiveManufacturer(part)] ? "branded" : "generic"; }
  // Everything a run costs, counted where it happens: Claude calls and the
  // model's own searches/fetches from each response's usage; page and image
  // downloads where OUR server makes them. Tokens are kept too.
  const USAGE0 = Object.freeze({ in: 0, out: 0, calls: 0, searches: 0, webFetches: 0, pageFetches: 0, imageFetches: 0, fastSearches: 0 });
  const MAX_CANDIDATES = 3;      // per part — bounds the vision calls
  const MAX_IMAGES_PER_PAGE = 2; // finder's URL (if any) + extracted ones
  const MAX_IMAGE_TRIES = 4;     // URLs downloaded and measured per page to find MAX_IMAGES_PER_PAGE usable ones
  function isLive(part) { return !!(part && part.photoState === "verified"); }

  // Pages our server read in the last few minutes: the fast path's product
  // page is not fetched a second time by the check step. Counted once.
  const PAGE_CACHE_MS = 10 * 60 * 1000, PAGE_CACHE_MAX = 60;
  const pageCache = new Map();
  async function fetchPageCached(url) {
    const hit = pageCache.get(url);
    if (hit && now() - hit.at < PAGE_CACHE_MS) return { html: hit.html, finalUrl: hit.finalUrl, cached: true };
    const res = await fetchPage(url);
    pageCache.set(url, { html: res.html, finalUrl: res.finalUrl || url, at: now() });
    if (pageCache.size > PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value);
    return { html: res.html, finalUrl: res.finalUrl || url, cached: false };
  }

  // ---- control ---------------------------------------------------------
  // dryRun: the benchmark — live parts are included (nothing is written,
  // so nothing can be overwritten) and the record step keeps the verdict
  // on the run instead of in the stores.
  async function start({ skus = null, autoApprove = false, label = "", dryRun = false } = {}) {
    await load();
    if (state.run && ["running", "paused"].includes(state.run.status)) throw new Error("A backfill run is already in progress — pause or finish it first.");
    const parts = getParts() || {};
    const pick = (skus || Object.keys(parts)).filter((s) => parts[s] && (dryRun || !isLive(parts[s])));
    const rank = (p) => { const i = BRAND_ORDER.indexOf(p.manufacturer); return i < 0 ? 99 : i; };
    const order = pick.sort((a, b) => rank(parts[a]) - rank(parts[b]) || a.localeCompare(b));
    if (state.run) state.history = [...(state.history || []), summary(state.run)].slice(-20);
    state.run = {
      id: "BF-" + new Date(now()).toISOString().replace(/[-:T]/g, "").slice(0, 12) + "-" + crypto.randomBytes(2).toString("hex"),
      label, status: "running", createdAt: new Date(now()).toISOString(),
      options: { autoApprove: !!autoApprove, dryRun: !!dryRun },
      order,
      items: Object.fromEntries(order.map((s) => [s, { step: "queued", attempts: 0, nextAt: 0, lastError: null, work: {}, result: null, usage: { ...USAGE0 } }])),
      usage: { ...USAGE0 }
    };
    await save();
    log({ action: "backfill.start", runId: state.run.id, count: order.length, autoApprove: !!autoApprove, dryRun: !!dryRun });
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
      // A dry run changed nothing, so there is nothing to group or rebuild.
      if (afterRun && !r.options.dryRun) {
        try { await afterRun(r); }
        catch (err) { log({ action: "backfill.after-run-error", runId: r.id, error: String(err && err.message || err) }); }
      }
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
        // Wall time per part: from leaving the queue to done/error
        // (retry back-offs included — they are part of what it cost).
        if ((it.step === "done" || it.step === "error") && !it.finishedAt) {
          it.finishedAt = now();
          it.ms = it.startedAt ? it.finishedAt - it.startedAt : null;
        }
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
    const bump = (k, n = 1) => { it.usage[k] = (it.usage[k] || 0) + n; r.usage[k] = (r.usage[k] || 0) + n; };
    // One call of this = one Claude API response (pause_turn resumes count too).
    const usage = (u) => {
      const st = (u && u.server_tool_use) || {};
      bump("calls"); bump("in", u.input_tokens || 0); bump("out", u.output_tokens || 0);
      bump("searches", st.web_search_requests || 0); bump("webFetches", st.web_fetch_requests || 0);
    };
    const getPage = async (url) => { const res = await fetchPageCached(url); if (!res.cached) bump("pageFetches"); return res; };
    const getImage = async (url) => { bump("imageFetches"); return fetchImage(url); };

    if (it.step === "queued") {
      it.startedAt = it.startedAt || now();
      // A live photo is never re-searched — except in a dry run, which
      // writes nothing and exists to compare against what is live.
      if (isLive(raw) && !r.options.dryRun) { it.result = { tier: "skipped", reason: "Already has a live photo." }; it.step = "done"; return; }
      it.step = "find";
      return;
    }

    if (it.step === "find") {
      let found = { identified: null, candidates: [], notes: [], pass: null, remainingPasses: [], via: "ai" };
      const passes = ai.passesFor(part);
      // Fast path first (Patrick, Sep 28 2026): the supplier's own search
      // and product page, no model. Its pages become candidates exactly
      // like the finder's; the check step judges them the same way.
      if (fastLookup) {
        const fast = await fastLookup.lookup(part, { kind, fetchPage: getPage });
        bump("fastSearches", fast.searches.filter((s) => s.fetch === "ok").length);
        it.work.fast = { candidates: fast.candidates.length, searches: fast.searches, sources: fast.sources, notes: fast.notes, identified: fast.identified || null };
        if (fast.candidates.length) {
          found.candidates = fast.candidates.slice(0, MAX_CANDIDATES).map((c) => ({
            pageUrl: c.pageUrl, imageUrl: "", partNumberAsShown: c.partNumberAsShown || "", pass: 0, via: `fast:${c.source}`, maxImages: c.maxImages || MAX_IMAGES_PER_PAGE,
            domain: c.domain, official: !!c.official, title: c.title || "", supplierSku: c.supplierSku || "", specs: c.specs || []
          }));
          if (fast.identified) found.identified = { manufacturer: fast.identified.manufacturer || part.manufacturerLabel, manufacturerPartNumber: fast.identified.manufacturerPartNumber };
          found.pass = 0; found.remainingPasses = passes; found.via = "fast";
          found.notes.push(`fast path: ${fast.candidates.length} product page${fast.candidates.length === 1 ? "" : "s"} (${[...new Set(fast.candidates.map((c) => c.source))].join(", ")})`);
        } else {
          found.notes.push(`fast path: ${fast.notes.join("; ") || "nothing found"}`);
        }
      }
      // The finder runs only when the fast path fell short: nothing found,
      // or (generic) a single source — a Confident generic result needs a
      // second, independent one, so the LAST pass looks for it.
      const domains = new Set(found.candidates.map((c) => c.domain));
      const needAi = !found.candidates.length || (kind === "generic" && domains.size < 2);
      const passList = !found.candidates.length ? passes : [passes[passes.length - 1]];
      if (needAi) for (const pass of passList) {
        const res = await ai.find(part, pass, usage);
        // A product PAGE is enough: our server reads its images (check step).
        const cands = (res.candidates || []).filter((c) => /^https:\/\//i.test(c.pageUrl || "") && !found.candidates.some((f) => f.pageUrl === c.pageUrl)).slice(0, MAX_CANDIDATES);
        found.notes.push(`pass ${pass}: ${res.notes || ""}`.trim());
        if (res.manufacturerPartNumber && !found.identified) found.identified = { manufacturer: res.manufacturer || part.manufacturerLabel, manufacturerPartNumber: res.manufacturerPartNumber };
        if (cands.length) {
          found.candidates = [...found.candidates, ...cands.map((c) => ({
            pageUrl: c.pageUrl, imageUrl: /^https:\/\//i.test(c.imageUrl || "") ? c.imageUrl : "", partNumberAsShown: c.partNumberAsShown || "", pass,
            domain: ev.hostOf(c.pageUrl), official: ev.isOfficialManufacturerPage(c.pageUrl, part.manufacturer)
          }))].slice(0, MAX_CANDIDATES + 1);
          // Remembered for the check step: if OUR server can't read any of
          // these pages, the next pass may still be tried (once).
          found.pass = pass;
          found.remainingPasses = passes.slice(passes.indexOf(pass) + 1);
          found.via = found.via === "fast" ? "fast+ai" : "ai";
          break;
        }
      }
      it.work.found = found;
      it.step = found.candidates.length ? "check" : "tier";
      return;
    }

    if (it.step === "check") {
      const spec = ev.parseSpec(part);
      const ours = [part.partNumber, part.sku, ...part.supplierSkus];
      const theirs = it.work.found.identified ? [it.work.found.identified.manufacturerPartNumber] : [];
      // Names an <img> may carry on the page: our numbers and the model's.
      const imageKeys = [...ours, ...theirs];
      let withImage = 0;
      const toCandidates = (res, pass) => (res.candidates || []).filter((c) => /^https:\/\//i.test(c.pageUrl || "")).slice(0, MAX_CANDIDATES).map((c) => ({
        pageUrl: c.pageUrl, imageUrl: /^https:\/\//i.test(c.imageUrl || "") ? c.imageUrl : "", partNumberAsShown: c.partNumberAsShown || "", pass,
        domain: ev.hostOf(c.pageUrl), official: ev.isOfficialManufacturerPage(c.pageUrl, part.manufacturer)
      }));
      // Diagnostics (Patrick, Sep 27 2026): one line per product page OUR
      // server checked — the URL, official or not, how the fetch went, the
      // part-number result, how many image candidates came out, and a
      // concise note when it went nowhere. Kept on the result and shown on
      // the review card, so "no reliable photo" always says why.
      const checkCandidates = async (candidates) => {
        const checked = [], pages = [];
        for (const c of candidates) {
          if (withImage >= MAX_CANDIDATES) break;
          const base = { source: { pageUrl: c.pageUrl, imageUrl: c.imageUrl || "", domain: c.domain, pass: c.pass, official: c.official }, notes: [] };
          const pg = { url: c.pageUrl, domain: c.domain, official: !!c.official, pass: c.pass, fetch: "ok", status: null, partNumber: null, images: 0, note: "" };
          pages.push(pg);
          let page;
          try { page = await getPage(c.pageUrl); }
          catch (err) {
            if (isTransient(err)) throw err;
            const m = String(err.message || "").match(/HTTP (\d{3})|^(\d{3})$/);
            const status = Number(err.status || err.statusCode || (m && (m[1] || m[2])) || 0) || null;
            pg.fetch = "failed"; pg.status = status; pg.note = status ? `HTTP ${status}` : String(err.message || "fetch failed").slice(0, 120);
            base.notes.push(`page: ${err.message}`); checked.push(base); continue;
          }
          const pageUrl = page.finalUrl || c.pageUrl;
          base.source.pageUrl = pageUrl;
          pg.url = pageUrl;
          // The part number must be in the VISIBLE product text of the page
          // we downloaded. Ours (or a supplier's) → pass. Only the
          // manufacturer's number the finder named → "unknown": the page may
          // be right, but nothing ties it to OUR part, so Patrick looks.
          let pn = ev.partNumberOnPage(page.html, ours);
          if (pn.result !== "pass" && theirs.length) {
            const t = ev.partNumberOnPage(page.html, theirs);
            if (t.result === "pass") pn = { result: "unknown", reason: "Only the manufacturer's number (not ours) is on the page.", matched: t.matched };
          }
          // An OFFICIAL manufacturer page that doesn't print our number is
          // "needs a look", not a failure: manufacturers often show a base
          // SKU with the size as an option (Oil Creek's IRR100 for
          // POPO100300). It can never be Confident this way — unknown ≠ pass.
          if (pn.result === "fail" && c.official) pn = { result: "unknown", reason: "Official manufacturer page, but our part number isn't printed on it (variant / base-SKU pages do this) — needs a look.", matched: null };
          base.partNumber = pn;
          base.manufacturerNumberOnPage = theirs.length ? ev.partNumberOnPage(page.html, theirs).result === "pass" : false;
          if (kind === "generic") base.specMatch = ev.pageMatchesSpec(page.html, spec);
          // Images: the finder's URL if it gave one, then what OUR server
          // reads from the page's own structures (og:image, Product JSON-LD,
          // product <img>, an <img> named after the part, a large <img>).
          // Each is a candidate, nothing more, until the safe download and
          // the vision check have had their say.
          // Then RANKED (photo-quality.rankImageUrls): a larger member of the
          // same picture's family on the page is tried before a thumbnail
          // URL. Every download is measured before it is saved; an
          // obviously too-small or blurry image is skipped and noted, never
          // stored (Patrick, Sep 28 2026).
          const extracted = [];
          if (c.imageUrl) extracted.push({ url: c.imageUrl, via: "finder" });
          for (const im of ev.extractProductImages(page.html, pageUrl, { keys: imageKeys })) if (!extracted.some((x) => x.url === im.url)) extracted.push(im);
          const images = pq.rankImageUrls(extracted, { html: page.html, pageUrl, max: MAX_IMAGE_TRIES, skip: ev.IMG_SKIP });
          base.imagesOnPage = extracted.length;
          pg.partNumber = pn.result; pg.images = 0; pg.skipped = 0;
          const pgNotes = [];
          if (pn.result === "fail") pgNotes.push("part number missing");
          if (pn.result === "unknown") pgNotes.push("part number not confirmed");
          if (!images.length) {
            pgNotes.push("no product image found");
            pg.note = pgNotes.join("; ");
            base.notes.push("image: no product image found on the page (no og:image, product JSON-LD or product <img>)"); checked.push(base); continue;
          }
          const perPage = Math.min(MAX_IMAGES_PER_PAGE, c.maxImages || MAX_IMAGES_PER_PAGE);
          let got = 0, downloadFailed = 0;
          const skipped = [];
          // One picture, several sizes: once a usable member of a family is
          // saved, its smaller copies are not downloaded — the largest clean
          // shot of each picture is what gets kept.
          const savedFamilies = new Set();
          for (const im of images) {
            if (got >= perPage || withImage >= MAX_CANDIDATES) break;
            const family = pq.familyKeyOf(im.url);
            if (family && savedFamilies.has(family)) continue;
            const entry = { ...base, source: { ...base.source, imageUrl: im.url, imageVia: im.via, ...(im.upgradedFrom ? { upgradedFrom: im.upgradedFrom } : {}) }, notes: [...base.notes] };
            try {
              const img = await getImage(im.url);
              const look = await store.inspect(img.buffer);
              if (look.quality.grade === "reject") {
                skipped.push({ url: img.finalUrl || im.url, width: look.width, height: look.height, reason: look.quality.reason });
                base.notes.push(`image ${im.via}: skipped — ${look.quality.reason}`);
                pg.skipped++;
                continue;
              }
              const saved = await store.saveCandidateImage(img.buffer);
              Object.assign(entry, saved);
              entry.source.imageUrl = img.finalUrl || im.url;
              if (family) savedFamilies.add(family);
              checked.push(entry); got++; withImage++;
            } catch (err) {
              if (isTransient(err)) throw err;
              downloadFailed++;
              base.notes.push(`image ${im.via}: ${err.message}`);
            }
          }
          pg.images = got;
          if (skipped.length) { pg.skippedImages = skipped; pgNotes.push(`${skipped.length} image${skipped.length === 1 ? "" : "s"} skipped: ${skipped.map((s) => s.reason).join("; ")}`); }
          if (!got) { pgNotes.push(skipped.length && !downloadFailed ? "no usable image" : "image download failed"); checked.push(base); }
          pg.note = pgNotes.join("; ");
        }
        return { checked, pages };
      };
      let { checked, pages } = await checkCandidates(it.work.found.candidates);
      // Fall through (Patrick, Sep 27 2026): the pass found pages, but OUR
      // server could read NONE of them (403/404/…). Then — once — the next
      // search pass runs, exactly as it would have if the first had found
      // nothing. A reachable page that merely fails verification is
      // evidence, not a reason to look elsewhere.
      const unreachable = pages.length > 0 && pages.every((p) => p.fetch !== "ok");
      const remaining = it.work.found.remainingPasses || [];
      if (unreachable && remaining.length && !it.work.fellThrough) {
        const nextPass = remaining[0];
        const res = await ai.find(part, nextPass, usage);
        const cands = toCandidates(res, nextPass);
        it.work.found.notes.push(`pass ${nextPass} (after unreachable pages): ${res.notes || ""}`.trim());
        if (res.manufacturerPartNumber && !it.work.found.identified) it.work.found.identified = { manufacturer: res.manufacturer || part.manufacturerLabel, manufacturerPartNumber: res.manufacturerPartNumber };
        it.work.fellThrough = { from: it.work.found.pass, to: nextPass, found: cands.length, at: new Date(now()).toISOString() };
        if (cands.length) {
          it.work.found.candidates = [...it.work.found.candidates, ...cands];
          const more = await checkCandidates(cands);
          checked = [...checked, ...more.checked];
          pages = [...pages, ...more.pages];
        }
      }
      it.work.checked = checked;
      it.work.pages = pages;
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
          try { page = await getPage(c.pageUrl); }
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
      // Among candidates of the same tier the highest-quality clean shot
      // wins: grade (good > ok > low), then the source's longest side, then
      // official pages, then the earlier pass. Low quality can never back
      // a Confident result (photo-quality.qualityCap) — the evidence checks
      // that produced the tier are untouched.
      const grade = { good: 0, ok: 1, low: 2 };
      const q = (c) => (c.quality && grade[c.quality.grade] !== undefined ? grade[c.quality.grade] : 3);
      const longest = (c) => (c.imageSource ? Math.max(c.imageSource.width || 0, c.imageSource.height || 0) : Math.max(c.width || 0, c.height || 0));
      for (const s of scored) s.t = pq.qualityCap(s.t, s.c.quality);
      scored.sort((x, y) => order[x.t.tier] - order[y.t.tier] || q(x.c) - q(y.c) || longest(y.c) - longest(x.c) || (y.c.source.official ? 1 : 0) - (x.c.source.official ? 1 : 0) || x.c.source.pass - y.c.source.pass);
      const best = scored[0];
      const t = best ? best.t : ev.tierFor({ kind, hasCandidate: false });
      const notes = (it.work.found && it.work.found.notes || []).join(" ");
      const pagesLine = pageDiagnosticsLine(it.work.pages || []);
      it.work.tier = {
        tier: t.tier,
        reason: best ? t.reason : `${t.reason}${pagesLine ? " " + pagesLine : ""} ${notes}`.trim(),
        qualityCapped: !!(best && t.qualityCapped),
        via: it.work.found ? it.work.found.via || "ai" : null,
        chosenHash: best ? best.c.hash : null,
        candidates: scored.map(({ c, t: ct }) => ({ hash: c.hash, width: c.width, height: c.height, sizes: c.sizes || null, imageSource: c.imageSource || null, sharpness: c.sharpness ?? null, quality: c.quality || null, source: c.source, tier: ct.tier,
          checks: { partNumber: c.partNumber || null, specMatch: c.specMatch || null, vision: c.vision || null, crossSource: kind === "generic" ? it.work.cross || null : null } }))
      };
      it.step = "record";
      return;
    }

    if (it.step === "record") {
      const t = it.work.tier;
      const chosen = t.candidates.findIndex((c) => c.hash === t.chosenHash);
      // Dry run (the fast-path benchmark): the verdict stays on the run for
      // the report and NOTHING is written to the photo stores — no group,
      // no link, no review card, no live photo.
      if (r.options.dryRun) {
        it.result = { tier: t.tier, reason: t.reason, live: false, dryRun: true, groupId: null, via: t.via || null, qualityCapped: !!t.qualityCapped, candidates: t.candidates.length, chosen: chosen >= 0 ? t.candidates[chosen] : null };
        it.step = "done";
        return;
      }
      const res = await store.recordAiResult(sku, raw, {
        tier: t.tier, kind, reason: t.reason, runId: r.id,
        identified: it.work.found && it.work.found.identified, candidates: t.candidates, chosen,
        proposedBrand: part.manufacturerProposed ? part.manufacturer : null,
        pages: it.work.pages || []
      }, { autoApprove: r.options.autoApprove });
      it.result = { tier: t.tier, reason: t.reason, live: !!res.live, skipped: res.skipped || null, groupId: res.groupId || null, via: t.via || null, qualityCapped: !!t.qualityCapped };
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
    // The "Fittings to confirm" list outlives the run. A pair Patrick has
    // already answered is never asked again.
    const known = new Set((state.fittings || []).map((f) => f.id));
    for (const p of proposals) {
      const id = pairId(p.a, p.b);
      if (known.has(id)) continue;
      known.add(id);
      (state.fittings ||= []).push({ id, a: p.a, b: p.b, reason: p.reason, runId: state.run.id, at: new Date(now()).toISOString(), status: "open" });
    }
    await save();
    log({ action: "backfill.grouping", runId: state.run.id, autoLinked: applied.length, proposals: proposals.length });
    return state.run.grouping;
  }

  function pairId(a, b) { return [a, b].sort().join("|"); }

  // "Fittings to confirm" (M3b). confirm: `keep` is the SKU whose photo the
  // fitting keeps; the other SKU joins its fitting as Patrick's link.
  // dismiss: not the same fitting; never proposed again.
  async function fittingsToConfirm() {
    await load();
    return (state.fittings || []).filter((f) => f.status === "open");
  }
  async function resolveFitting(id, { action, keep, by }) {
    await load();
    const f = (state.fittings || []).find((x) => x.id === id);
    if (!f) throw new Error("That fitting proposal doesn't exist.");
    if (f.status !== "open") throw new Error("That proposal was already answered.");
    let result = null;
    if (action === "confirm") {
      if (keep !== f.a && keep !== f.b) throw new Error("Choose which photo the fitting keeps.");
      const mover = keep === f.a ? f.b : f.a;
      const parts = getParts() || {};
      if (!parts[mover] || !parts[keep]) throw new Error("One of these parts is no longer in the catalog.");
      const { links } = await store.snapshot();
      const targetGroup = links[keep] && links[keep].groupId;
      if (!targetGroup) throw new Error(`${keep} has no photo group to share.`);
      result = await store.linkToGroup(mover, parts[mover], targetGroup, { by });
      f.kept = keep;
    } else if (action !== "dismiss") {
      throw new Error("Unknown action.");
    }
    f.status = action === "confirm" ? "confirmed" : "dismissed";
    f.resolvedBy = by;
    f.resolvedAt = new Date(now()).toISOString();
    await save();
    log({ action: `backfill.fitting.${f.status}`, id, keep: f.kept || null, by });
    return { fitting: f, result };
  }

  // ---- The calibration run (M3c) ------------------------------------------
  // The ONLY way the server starts a run. Hard limits, not options: the
  // approved 15-part mixed sample (8 branded, 7 generic), auto-approve OFF,
  // parts that already have a live photo excluded, one run at a time.
  const CALIBRATION = Object.freeze({ branded: 8, generic: 7 });
  const CALIBRATION_MAX = CALIBRATION.branded + CALIBRATION.generic;

  function calibrationSkus() { return calibrationPlan().skus; }

  // What the run WOULD do, with an honest worst-case count of the calls it
  // can make. Per SKU: one finder call per search pass until something is
  // found (branded: manufacturer site, then suppliers; generic: suppliers,
  // then the open web), one extra finder call for a branded part whose
  // number turns out to be a distributor code, one vision call per
  // candidate (≤3), one compare call for a generic part with two sources.
  // Each finder call may use up to 6 web searches and 6 web fetches.
  function calibrationPlan() {
    const parts = getParts() || {};
    const sample = ev.pickCalibrationSample(Object.values(parts), { ...CALIBRATION, isLive });
    const skus = sample.skus.slice(0, CALIBRATION_MAX).filter((s) => parts[s] && !isLive(parts[s]));
    const rows = skus.map((sku) => {
      const p = enrich(parts[sku]);
      const kind = kindOf(p);
      const passes = ai.passesFor(p);
      const finderMax = passes.length + (kind === "branded" ? 1 : 0);
      return {
        sku, kind, manufacturer: p.manufacturer || "", proposedBrand: p.manufacturerProposed ? p.manufacturer : null,
        description: p.description || "", size: p.size || "", category: p.category || "",
        passes,
        calls: { finderMin: 1, finderMax, verifyMax: 3, compareMax: kind === "generic" ? 1 : 0 }
      };
    });
    const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
    const finderMin = sum((r) => r.calls.finderMin), finderMax = sum((r) => r.calls.finderMax);
    const verifyMax = sum((r) => r.calls.verifyMax), compareMax = sum((r) => r.calls.compareMax);
    return {
      skus, rows, autoApprove: false,
      counts: { total: rows.length, branded: rows.filter((r) => r.kind === "branded").length, generic: rows.filter((r) => r.kind === "generic").length },
      estimate: {
        apiCalls: { min: finderMin, max: finderMax + verifyMax + compareMax },
        finderCalls: { min: finderMin, max: finderMax }, verifyCalls: { max: verifyMax }, compareCalls: { max: compareMax },
        webSearches: { max: finderMax * 6 }, webFetchesByModel: { max: finderMax * 6 },
        pagesFetchedByOurServer: { max: sum((r) => 3 + (r.kind === "branded" ? 3 : 0)) },
        imagesFetchedByOurServer: { max: rows.length * 3 }
      }
    };
  }

  async function startCalibration({ by = null } = {}) {
    await load();
    if (state.run && ["running", "paused"].includes(state.run.status)) throw new Error("A run is already active — pause or finish it first.");
    const plan = calibrationPlan();
    if (!plan.skus.length) throw new Error("Nothing to calibrate — every sample part already has a live photo.");
    if (plan.skus.length > CALIBRATION_MAX) throw new Error("Calibration sample is larger than allowed.");
    await start({ skus: plan.skus, autoApprove: false, label: "Calibration" });
    state.run.calibration = { by, skus: plan.skus, estimate: plan.estimate, at: new Date(now()).toISOString() };
    state.run.options.autoApprove = false; // belt and braces: never on for a calibration
    await save();
    log({ action: "backfill.calibration.start", runId: state.run.id, by, skus: plan.skus });
    return status();
  }

  // ---- The controlled wave (Patrick, Sep 27 2026) --------------------------
  // At most WAVE_MAX unprocessed parts, deliberately mixed (photo-evidence
  // .pickWave). Excluded: live parts, parts waiting for review or already
  // judged, and everything any calibration run processed. Start requires
  // the exact SKU list that was shown, so a changed catalog can never run a
  // list Patrick didn't see. Auto-approve OFF, one run at a time. There is
  // still no whole-catalog door.
  // Waves of up to 50 (Patrick, Sep 27 2026, after the 30-part wave). Never
  // the whole catalog in one run.
  const WAVE_MAX = 50;
  // Every part any calibration or wave has already processed — from the
  // current run and the history — so a later wave never repeats one, even
  // a part that ended in an error and still shows no photo state.
  function processedByRuns() {
    const out = new Set();
    const add = (run) => {
      if (!run) return;
      for (const key of ["calibration", "wave"]) if (run[key] && Array.isArray(run[key].skus)) run[key].skus.forEach((s) => out.add(s));
      if (Array.isArray(run.order)) run.order.forEach((s) => out.add(s));
    };
    add(state && state.run);
    for (const h of (state && state.history) || []) add(h);
    return out;
  }
  const processedByCalibration = processedByRuns;
  function estimateRows(rows) {
    const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
    const finderMin = sum((r) => r.calls.finderMin), finderMax = sum((r) => r.calls.finderMax);
    const verifyMax = sum((r) => r.calls.verifyMax), compareMax = sum((r) => r.calls.compareMax);
    return {
      apiCalls: { min: finderMin, max: finderMax + verifyMax + compareMax },
      finderCalls: { min: finderMin, max: finderMax }, verifyCalls: { max: verifyMax }, compareCalls: { max: compareMax },
      webSearches: { max: finderMax * 6 }, webFetchesByModel: { max: finderMax * 6 },
      pagesFetchedByOurServer: { max: sum((r) => 3 + (r.kind === "branded" ? 3 : 0)) },
      imagesFetchedByOurServer: { max: rows.length * 3 }
    };
  }
  function rowFor(sku, parts) {
    const p = enrich(parts[sku]);
    const kind = kindOf(p);
    const passes = ai.passesFor(p);
    return {
      sku, kind, manufacturer: p.manufacturer || "", proposedBrand: p.manufacturerProposed ? p.manufacturer : null,
      description: p.description || "", size: p.size || "", category: p.category || "",
      passes, calls: { finderMin: 1, finderMax: passes.length + (kind === "branded" ? 1 : 0), verifyMax: 3, compareMax: kind === "generic" ? 1 : 0 }
    };
  }
  function wavePlan({ size = WAVE_MAX } = {}) {
    const n = Math.max(1, Math.min(WAVE_MAX, Number(size) || WAVE_MAX));
    const parts = getParts() || {};
    const done = processedByCalibration();
    const isExcluded = (p) => isLive(p) || (p.photoState && p.photoState !== "none") || done.has(p.sku);
    const wave = ev.pickWave(Object.values(parts), { size: n, isExcluded });
    const rows = wave.skus.map((s) => rowFor(s, parts));
    return {
      skus: wave.skus, rows, autoApprove: false, max: WAVE_MAX,
      counts: { total: rows.length, branded: rows.filter((r) => r.kind === "branded").length, generic: rows.filter((r) => r.kind === "generic").length,
        categories: [...new Set(rows.map((r) => r.category))].sort(), manufacturers: [...new Set(rows.map((r) => r.manufacturer).filter(Boolean))].sort() },
      eligible: Object.values(parts).filter((p) => !isExcluded(p)).length,
      estimate: estimateRows(rows)
    };
  }
  async function startWave({ by = null, skus = null, size = WAVE_MAX } = {}) {
    await load();
    if (state.run && ["running", "paused"].includes(state.run.status)) throw new Error("A run is already active — pause or finish it first.");
    const plan = wavePlan({ size });
    if (!plan.skus.length) throw new Error("Nothing left to process — every eligible part is live, waiting for review, or already run.");
    if (plan.skus.length > WAVE_MAX) throw new Error("Wave is larger than allowed.");
    // The list Patrick approved must be the list that runs — no more, no
    // less, and in the same order the plan shows it.
    if (!Array.isArray(skus) || JSON.stringify(skus.map(String)) !== JSON.stringify(plan.skus)) {
      throw new Error("The wave plan has changed since it was shown — reload the plan and confirm the exact list.");
    }
    await start({ skus: plan.skus, autoApprove: false, label: `Wave (${plan.skus.length} parts)` });
    state.run.wave = { by, skus: plan.skus, estimate: plan.estimate, at: new Date(now()).toISOString() };
    state.run.options.autoApprove = false;
    await save();
    log({ action: "backfill.wave.start", runId: state.run.id, by, skus: plan.skus });
    return status();
  }

  // ---- The fast-path benchmark (Patrick, Sep 28 2026) ----------------------
  // A DRY RUN on at most BENCHMARK_MAX parts that earlier runs already
  // processed. The whole pipeline runs — fast path, finder fallback, our
  // fetches, the vision check, the quality gate, the tier — and every
  // verdict stays on the run for the report. Nothing reaches the photo
  // stores: no group, no link, no review card, no live photo, and no
  // grouping afterwards. Auto-approve OFF, one run at a time, and the exact
  // list shown must be the list sent.
  const BENCHMARK_MAX = 10;
  // Ten parts from the completed calibration and waves, mixed on purpose:
  // five branded (a Confident Hunter module, the Hunter flow meter that
  // ended on a family image, a Rain Bird nozzle, an Oil Creek roll whose
  // official site blocks us, a Dawn saddle) and five generic (poly plug,
  // clamp, PVC bushing, poly pipe roll, PVC nipple).
  const BENCHMARK_DEFAULT = Object.freeze(["HCPCM300", "HC150FLOW", "R12H", "POPO150250", "DS75C", "1449-007", "SC8112", "439211", "PP075X400", "205020"]);
  // The most recent finished run with a usage split, for the comparison.
  function baselineUsage() {
    const list = [...((state && state.history) || [])].reverse();
    if (state && state.run && state.run.status === "done") list.unshift(summary(state.run));
    const pick = list.find((r) => r && r.wave && r.status === "done" && r.usageByKind) || list.find((r) => r && r.status === "done" && r.usageByKind && !r.dryRun);
    if (!pick) return null;
    return { runId: pick.id, label: pick.label, usageByKind: pick.usageByKind, usage: pick.usage, counts: pick.counts, createdAt: pick.createdAt, finishedAt: pick.finishedAt };
  }
  function benchmarkPlan({ skus = BENCHMARK_DEFAULT } = {}) {
    const parts = getParts() || {};
    const done = processedByRuns();
    // Canonical order (the agreed list's order, then alphabetical), so the
    // list sent back must be THE plan, not merely a shuffle of it.
    const rank = (s) => { const i = BENCHMARK_DEFAULT.indexOf(s); return i < 0 ? 1000 : i; };
    const list = [...new Set((skus || []).map(String))].slice(0, BENCHMARK_MAX).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const rows = list.filter((s) => parts[s]).map((s) => ({ ...rowFor(s, parts), live: isLive(parts[s]), photoState: parts[s].photoState || "none", processedBefore: done.has(s) }));
    const problems = [];
    for (const s of list) if (!parts[s]) problems.push(`${s}: not in the catalog`);
    for (const r of rows) if (!r.processedBefore) problems.push(`${r.sku}: no earlier run processed it`);
    return {
      skus: rows.map((r) => r.sku), rows, autoApprove: false, dryRun: true, max: BENCHMARK_MAX, problems,
      counts: { total: rows.length, branded: rows.filter((r) => r.kind === "branded").length, generic: rows.filter((r) => r.kind === "generic").length },
      estimate: estimateRows(rows), baseline: baselineUsage(), fastSources: fastLookup ? fastLookup.sources : []
    };
  }
  async function startBenchmark({ by = null, skus = null } = {}) {
    await load();
    if (state.run && ["running", "paused"].includes(state.run.status)) throw new Error("A run is already active — pause or finish it first.");
    const plan = benchmarkPlan(Array.isArray(skus) && skus.length ? { skus } : {});
    if (plan.problems.length) throw new Error(`Benchmark list refused: ${plan.problems.join("; ")}.`);
    if (!plan.skus.length) throw new Error("Nothing to benchmark.");
    if (plan.skus.length > BENCHMARK_MAX) throw new Error("Benchmark is larger than allowed.");
    if (!Array.isArray(skus) || JSON.stringify(skus.map(String)) !== JSON.stringify(plan.skus)) {
      throw new Error("The benchmark list differs from the plan shown — reload the plan and confirm the exact list.");
    }
    const baseline = plan.baseline;
    await start({ skus: plan.skus, autoApprove: false, dryRun: true, label: `Fast-path benchmark (${plan.skus.length} parts, dry run)` });
    state.run.benchmark = { by, skus: plan.skus, at: new Date(now()).toISOString(), baseline };
    state.run.options.autoApprove = false;
    state.run.options.dryRun = true;
    await save();
    log({ action: "backfill.benchmark.start", runId: state.run.id, by, skus: plan.skus });
    return status();
  }

  // The calibration parts that still have no live photo — from the most
  // recent calibration run on file (current or history).
  function lastCalibration() {
    if (state.run && state.run.calibration) return state.run.calibration;
    const past = [...(state.history || [])].reverse().find((h) => h.calibration && h.calibration.skus);
    return past ? past.calibration : null;
  }
  function unresolvedCalibrationSkus() {
    const cal = lastCalibration();
    if (!cal) return [];
    const parts = getParts() || {};
    return cal.skus.filter((s) => parts[s] && !isLive(parts[s]));
  }
  // Re-run ONLY those (Patrick, Sep 27 2026): never the whole sample, never
  // the catalog, auto-approve OFF, one run at a time.
  // `only`: an optional subset — every entry must be one of the unresolved
  // calibration parts, or the whole request is refused.
  async function startCalibrationRerun({ by = null, only = null } = {}) {
    await load();
    if (state.run && ["running", "paused"].includes(state.run.status)) throw new Error("A run is already active — pause or finish it first.");
    const cal = lastCalibration();
    if (!cal) throw new Error("There is no calibration run to re-run.");
    let skus = unresolvedCalibrationSkus();
    if (!skus.length) throw new Error("Every calibration part already has a live photo — nothing to re-run.");
    if (Array.isArray(only) && only.length) {
      const wanted = [...new Set(only.map(String))];
      const outside = wanted.filter((s) => !skus.includes(s));
      if (outside.length) throw new Error(`Not among the unresolved calibration parts: ${outside.join(", ")}.`);
      skus = skus.filter((s) => wanted.includes(s));
    }
    const rerunOf = (state.run && state.run.calibration === cal) ? state.run.id : null;
    await start({ skus, autoApprove: false, label: "Calibration re-run" });
    state.run.calibration = { by, skus, rerunOf, at: new Date(now()).toISOString(), estimate: null };
    state.run.options.autoApprove = false;
    await save();
    log({ action: "backfill.calibration.rerun", runId: state.run.id, by, skus, rerunOf });
    return status();
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
    const current = run.order.find((s) => !["done", "error", "queued"].includes(run.items[s].step)) || null;
    // Usage split by kind (Patrick, Sep 27 2026): what a branded part costs
    // against a generic one, from each part's own counters.
    const parts = getParts() || {};
    const byKind = { branded: { ...USAGE0, parts: 0 }, generic: { ...USAGE0, parts: 0 } };
    for (const s of run.order) {
      const k = parts[s] ? kindOf(enrich(parts[s])) : "generic";
      const u = (run.items[s] && run.items[s].usage) || {};
      byKind[k].parts += 1;
      for (const key of Object.keys(USAGE0)) byKind[k][key] += u[key] || 0;
    }
    for (const k of Object.keys(byKind)) {
      const n = byKind[k].parts;
      byKind[k].perPart = n ? { calls: +(byKind[k].calls / n).toFixed(1), in: Math.round(byKind[k].in / n), out: Math.round(byKind[k].out / n), searches: +(byKind[k].searches / n).toFixed(1) } : null;
    }
    // Fast path (Patrick, Sep 28 2026): how many finished parts the
    // supplier lookup resolved alone, how many needed the finder too, and
    // the wall time per part.
    const fast = { hits: 0, fastAndAi: 0, aiOnly: 0, none: 0 };
    let msSum = 0, msN = 0;
    for (const s of run.order) {
      const it = run.items[s];
      if (it.step === "done" && it.result && it.result.tier !== "skipped") {
        const via = (it.work && it.work.found && it.work.found.via) || (it.work && it.work.found ? "ai" : null);
        if (via === "fast") fast.hits++; else if (via === "fast+ai") fast.fastAndAi++; else if (via === "ai") fast.aiOnly++; else fast.none++;
      }
      if (typeof it.ms === "number") { msSum += it.ms; msN++; }
    }
    // Per-part rows for a benchmark run (small by construction).
    const rows = run.benchmark ? run.order.map((s) => {
      const it = run.items[s];
      const p = parts[s];
      const u = it.usage || {};
      const chosen = it.result && it.result.chosen;
      return {
        sku: s, kind: p ? kindOf(enrich(p)) : null, step: it.step, via: (it.work && it.work.found && it.work.found.via) || null,
        tier: it.result ? it.result.tier : null, reason: it.result ? it.result.reason : (it.lastError || null), qualityCapped: !!(it.result && it.result.qualityCapped),
        candidates: it.result ? it.result.candidates || 0 : 0,
        chosen: chosen ? { hash: chosen.hash, quality: chosen.quality || null, imageSource: chosen.imageSource || null, width: chosen.width, height: chosen.height, domain: chosen.source && chosen.source.domain, pageUrl: chosen.source && chosen.source.pageUrl, imageVia: chosen.source && chosen.source.imageVia } : null,
        fast: it.work && it.work.fast ? { candidates: it.work.fast.candidates, searches: it.work.fast.searches.length } : null,
        usage: { calls: u.calls || 0, in: u.in || 0, out: u.out || 0, searches: u.searches || 0, webFetches: u.webFetches || 0, pageFetches: u.pageFetches || 0, imageFetches: u.imageFetches || 0, fastSearches: u.fastSearches || 0 },
        ms: typeof it.ms === "number" ? it.ms : null,
        livePhoto: p && p.photo ? { width: p.photo.width, height: p.photo.height, domain: p.photo.sourceDomain || null } : null
      };
    }) : null;
    return {
      id: run.id, label: run.label, status: run.status, autoApprove: run.options.autoApprove, dryRun: !!run.options.dryRun, createdAt: run.createdAt, finishedAt: run.finishedAt || null,
      interruptedAt: run.interruptedAt || null,
      fast, timing: { avgMs: msN ? Math.round(msSum / msN) : null, parts: msN },
      benchmark: run.benchmark ? { skus: run.benchmark.skus, by: run.benchmark.by, baseline: run.benchmark.baseline || null, rows } : null,
      calibration: run.calibration ? { skus: run.calibration.skus, by: run.calibration.by, rerunOf: run.calibration.rerunOf || null, unresolved: (() => { const parts = getParts() || {}; return run.calibration.skus.filter((s) => parts[s] && !isLive(parts[s])); })() } : null,
      wave: run.wave ? { skus: run.wave.skus, by: run.wave.by } : null,
      usageByKind: byKind,
      current: current ? { sku: current, step: run.items[current].step } : null,
      errors: run.order.filter((s) => run.items[s].step === "error").map((s) => ({ sku: s, step: run.items[s].failedStep || null, error: run.items[s].lastError })),
      counts: c, usage: run.usage
    };
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

  return { load, start, pause, resume, retry, status, idle, kick, groupingProposals, applyGrouping, calibrationSkus, calibrationPlan, startCalibration, startCalibrationRerun, unresolvedCalibrationSkus, wavePlan, startWave, benchmarkPlan, startBenchmark, BENCHMARK_DEFAULT, fittingsToConfirm, resolveFitting, catalogProgress, _state: () => state };
}

module.exports = { createBackfill, isTransient, pageDiagnosticsLine, STEPS };
