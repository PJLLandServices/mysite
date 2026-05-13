// ServiceWorker for the tech-mode work-order page (spec §4.3.3 rule
// #12 — "Offline mode mandatory. Captured locally, synced when service
// returns").
//
// Scope: /admin/work-order/*/tech — the field surface that genuinely
// needs to keep working when the truck rolls past a dead zone.
//
// What's cached on install:
//   - The tech HTML shell + JS + CSS + small helpers
//   - pricing.json + parts.json (for the materials checklist)
//
// What's cached on use:
//   - Each individual WO's GET response (so reopening works offline)
//   - Linked property GET responses (cheat sheet needs these)
//
// What's NOT in v1:
//   - Photo binary uploads queued offline (block until reconnect)
//   - Admin/CRM pages (out of scope — tech-mode only)
//   - Conflict resolution (last-write-wins; the queue replay endpoint
//     trusts the latest mutation, no IF-MATCH revision check)

// CACHE_VERSION must be bumped any time STATIC_ASSETS content changes.
// The activate handler below deletes any cache that doesn't match this
// exact string, so a bump invalidates every iPhone's stale copy. Skipped
// bumps mean tech phones keep serving pre-deployment HTML/JS/CSS even
// after the new code lands on Render — the symptom Patrick saw was
// "the zone bottom-sheet is gone again" because his phone had cached
// markup from before the +Add zone / multi-selects work landed.
//
// Bumped 2026-05-09 (v10 → v11): catches up on bf1a147 (+Add zone),
// Briefs A through G (history viewer, post-sig banner, AI bonus card,
// property-edits preview, on-site quote builder evolution), and the
// hot-fix multi-selects + horizontal-scroll changes.
// Bumped 2026-05-09 (v11 → v12): adds the "Delete zone" button in the
// zone bottom-sheet (with confirm prompt) — touches HTML, JS, and CSS,
// so phones still on v11 won't see the button until they update.
// Bumped 2026-05-12 (v12 → v13): two stacked deploys (7e53f22 +
// 863c6ac) shipped tech-mode JS/HTML/CSS changes without bumping this,
// so iPhones stayed on the v12 cache and ran old JS against new HTML.
// v13 catches up on:
//   • 7e53f22 — materials checklist persistence (beforeunload flush),
//     If-Match optimistic concurrency on patchWorkOrder + conflict
//     banner, uploadWoPhotos routed through PJLOffline.queuedFetch.
//   • 863c6ac — merged "Sign, lock & generate invoice" button +
//     pre-sign readiness gate + post-sig banner with invoice link.
// Bumped 2026-05-12 (v13 → v14): Brief: WO Field-Readiness — touches
// work-order-tech.html (file input accept widened; pre-sign checklist
// UI moved above canvas; tech recovery surfaces; finish bar hidden),
// work-order-tech.js (HEIC/PDF upload path + PDF tile rendering;
// readiness checklist render; recovery buttons; refresh-after-PATCH
// for issue creation), work-order-tech.css (layout safety net + pre-
// sign checklist styling + recovery button styling).
// Bumped 2026-05-12 (v14 → v15): brief-literal §4.6 materials-confirmation
// gate — adds the Confirm materials list button + materialsConfirmedAt
// field + clear-on-mutate. Touches work-order-tech.html + .js, so the
// SW cache needs to invalidate.
// Bumped 2026-05-12 (v15 → v16): offline-queue.js fix — strip If-Match
// from queued PATCHes at enqueue + replay. Patrick reported issue-add
// gets "Syncing X files" then reload loses the work; root cause was
// stale If-Match on queued replays → 409 → silent dequeue. Also adds
// /crm/offline-queue.js to STATIC_ASSETS so the SW versions it now.
// Bumped 2026-05-12 (v16 → v17): photo upload "Uploading…" stuck fix.
// processPhotoForUpload was using FileReader.readAsDataURL → Image.src
// = data: URL, which iOS Safari silently hangs on for >10 MB data URLs
// (typical for 48 MP iPhone HEICs base64-encoded). Switched to
// URL.createObjectURL (blob: URL, no size cap) and added 30 s decode
// timeout + 90 s upload timeout so a hang surfaces a clear error
// instead of leaving "Uploading…" indefinitely. Touches
// work-order-tech.js only.
// Bumped 2026-05-12 (v17 → v18): photo upload follow-up — Patrick
// reported v17 STILL hung on iPhone and the geo permission prompt
// was firing on every upload. Two fixes:
//   1. Removed geo from the upload critical path entirely. The
//      watermark uses a SYNC cached geo (set null until/unless a
//      prefetch resolves it). No more prompt-blocking-upload.
//   2. Switched primary decode path to createImageBitmap (iOS-
//      native; handles 48 MP HEICs without the Image() silent hang).
//      Image+blob URL is now the fallback.
// Touches work-order-tech.js only.
// Bumped 2026-05-12 (v18 → v19): photo upload — strip ALL client-side
// processing. Patrick reported v17 + v18 STILL hung on iPhone after
// multiple decode-path attempts. Burning hours guessing at why iOS
// Safari hangs on canvas/Image/createImageBitmap. New approach:
//   • Remove canvas pipeline entirely (no resize, no watermark)
//   • Read the raw file as base64 via FileReader and ship it as-is
//   • Per-stage status text on the upload chip so a hang at least
//     tells us WHICH stage hung ("Reading 1/3…" vs "Uploading…")
// Trade-offs accepted: bigger uploads (server already accepts 25 MB
// per file, 40 MB body), no client-side EXIF/watermark. We can add
// watermark server-side later once we know uploads actually land.
// Touches work-order-tech.js only.
// Bumped 2026-05-12 (v19 → v20): the per-stage label DID surface a
// real signal — Patrick saw "Reading 1/1…" hang forever. So the
// hang is FileReader, not the network. v20:
//   • Switch readAsDataURL → readAsArrayBuffer. The DataURL path has
//     to materialise the whole "data:image/heic;base64,…" string,
//     which iOS Safari can stall on for large iCloud-backed HEICs.
//     ArrayBuffer is the lower-level read; we chunk the base64
//     conversion ourselves (8 KB at a time so we don't blow the
//     fromCharCode stack on big files).
//   • Add FileReader.onprogress → live "Reading … 47%" updates so
//     a slow iCloud download shows motion instead of dead silence.
//   • Show file size in the label ("Reading 1/1 · 12.3 MB · 47%…")
//     so we can see if it's a 4 MB normal photo or a 30 MB iCloud
//     monster.
//   • 60 s hard timeout on FileReader. After v19 hung indefinitely,
//     a clear timeout error ("if iCloud, open Photos and tap to
//     download first") beats forever-spin.
// Touches work-order-tech.js only.
// Bumped 2026-05-12 (v20 → v21): Patrick reported v20 "back to doing
// nothing" — i.e. NO status change at all on file pick. That's
// unlikely to be a real regression in v20's code path (the first
// setUploadStatus call is at the top of the loop, before any async
// work). Strong suspicion: iPhone is still on stale cached JS
// (v18/v19) and hasn't actually picked up v20 yet. v21 adds:
//   • Visible build version badge in the bottom-left corner of every
//     tech page. JS sets it to "tech-v21" on load. If Patrick reads
//     it as "html only" → JS never executed. If it shows v19/v20 →
//     stale cache and we need a force-refresh. If v21 → he's
//     current and the bug is somewhere else.
//   • Immediate "Picked N file(s)…" status the moment the change
//     event fires, BEFORE any async work. If user picks a file and
//     sees nothing at all, the change event isn't firing (or fires
//     with 0 files).
//   • "No file selected — try again." stamp when files is empty (so
//     a misfire is visible rather than silent).
// Touches HTML + JS — HTML cache must invalidate too. The HTML uses
// network-first so a fresh load gets the new markup; only the JS
// fetch is cache-first.
// Bumped 2026-05-12 (v21 → v22): Patrick reported v21 also "did
// nothing" — AND it failed on DESKTOP too. That rules out iOS-
// specific issues. New hypothesis: a JS error somewhere in
// work-order-tech.js aborts module execution BEFORE the photo
// upload event handler attaches. The file has many unguarded
// `someEl.addEventListener(...)` calls; if any `someEl` is null
// (HTML+JS schema mismatch, partial cache), the whole module
// stops, the upload handler never binds, and tap-to-pick goes
// silent. v22:
//   • Global `window.error` + `window.unhandledrejection` handlers
//     paint the error message into the build badge (red bg). So
//     a thrown TypeError now shows up as "JS ERR: …" instead of
//     being invisible without dev-tools.
//   • Pre-attach the visit-photo upload listener at the TOP of the
//     script, before any unguarded code can throw. Belt-and-
//     suspenders: even if a later `addEventListener` blows up, the
//     photo handler is already bound. The original attachment at
//     line ~2011 is kept as a no-op fallback.
// Touches work-order-tech.js only.
// Lesson: bump this in the same commit as any change to the files in
// STATIC_ASSETS, otherwise the field tech sees old behaviour even
// after Render redeploys.
// Bumped 2026-05-12 (v22 → v23): brain-dead diagnostic upload. After
// v17-v22 all failed (last one: "literally NOTHING" on desktop AND
// iphone), this rip out queuedFetch, setUploadStatus, AbortController,
// chunked base64, and every other layer. Replace with: FileReader →
// fetch → done, with alert() at each step so the tech sees exactly
// where it stops. Intrusive, but invisible failure has cost us 6
// rounds. Touches work-order-tech.js only.
// Bumped 2026-05-12 (v23 → v24): MASSIVE breakthrough. Patrick's WO
// history viewer shows 6+ successful "Photo uploaded +1 (general)"
// audit entries spanning every test attempt. The uploads were
// LANDING on the server the whole time. The bug was never upload —
// it was the UI failing to refresh after upload so the new thumb
// never appeared in the photo strip. From the tech's seat: "nothing
// happens." From the server's seat: 6 photos saved to disk.
// v24 stops trying to fix the upload (it was always fine) and fixes
// the actual bug:
//   • Big "Uploading…" overlay so the tech KNOWS something is happening
//   • After successful POST, location.reload() — page re-fetches WO
//     and re-renders the photo strip from scratch with the new photo
//   • Crude (interrupts typing) but reliable. Proper render-without-
//     reload fix is a follow-up. Right now we need photos to APPEAR.
// Touches work-order-tech.js only.
// Bumped 2026-05-12 (v24 → v25): tech-mode layout + payment-radio fix.
// Patrick hit "Pre-sign gates unmet: payment method not selected" at
// submit time even though the No radio LOOKED checked. Two bugs:
//   • HTML had `checked` on the No radio, but the JS unchecks both
//     radios on render when state.paidOnSite is null. Visual was
//     lying about state. Removed `checked`. Tech now sees BOTH
//     radios unchecked → forced to actively pick one → state goes
//     to true/false → submit gate passes.
//   • The Signoff section sat above Payment in the HTML flow, so
//     the tech reached the signature canvas before ever scrolling
//     past payment. Moved Signoff to live AFTER Payment & Billing,
//     so the natural top-to-bottom scroll surfaces payment first
//     and signature last. Tap-jump from the pre-sign checklist
//     row to #techPaymentSection still works as a fallback.
// Touches work-order-tech.html only.
const CACHE_VERSION = "pjl-tech-v25";
const STATIC_ASSETS = [
  "/crm/work-order-tech.html",
  "/crm/work-order-tech.js",
  "/crm/work-order-tech.css",
  "/crm/offline-queue.js",
  "/crm/voice-input.js",
  "/pricing.json",
  "/parts.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Best-effort cache — a missing asset shouldn't block install.
      Promise.all(STATIC_ASSETS.map((url) =>
        fetch(url, { cache: "reload" }).then((res) => {
          if (res.ok) cache.put(url, res);
        }).catch(() => {})
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n.startsWith("pjl-tech-") && n !== CACHE_VERSION)
          .map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs through this SW. POST/PATCH go straight
  // to the network — the IndexedDB outbound queue lives in the page,
  // not here. Cross-origin (Google Fonts, Maps) ignored.
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") return;

  // Tech-mode HTML shell — network-first so refreshes pick up new
  // versions when online; cache fallback when offline.
  if (url.pathname.match(/^\/admin\/work-order\/[^/]+\/tech\/?$/)) {
    event.respondWith(networkFirst(req, "/crm/work-order-tech.html"));
    return;
  }

  // Static assets — cache-first since they're versioned by deploy.
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // WO + property GETs — network-first, cache the response so the next
  // offline open still works. Only WO + property — leads, quotes,
  // settings stay online-only for v1.
  if (url.pathname.match(/^\/api\/work-orders\/[^/]+$/) ||
      url.pathname.match(/^\/api\/properties\/[^/]+$/) ||
      url.pathname.match(/^\/api\/properties\/[^/]+\/deferred/)) {
    event.respondWith(networkFirstAndCache(req));
    return;
  }

  // Parts catalog — network-first (so price/SKU updates propagate as
  // soon as the next page load happens online) but cached so the modal
  // + bringback section open instantly on subsequent loads + work
  // offline. Catalog is small (~35 KB) so this is essentially free.
  if (url.pathname === "/api/parts") {
    event.respondWith(networkFirstAndCache(req));
    return;
  }
});

async function networkFirst(req, fallbackUrl) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(fallbackUrl || req.url, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(fallbackUrl || req.url);
    if (cached) return cached;
    throw new Error("offline + no cached response");
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) {
    const cache = await caches.open(CACHE_VERSION);
    cache.put(req, res.clone());
  }
  return res;
}

async function networkFirstAndCache(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Return a stub 503 so the page knows we're offline + miss.
    return new Response(JSON.stringify({ ok: false, offline: true, errors: ["Offline and no cached response."] }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
  }
}
