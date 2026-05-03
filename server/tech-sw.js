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

const CACHE_VERSION = "pjl-tech-v9";
const STATIC_ASSETS = [
  "/crm/work-order-tech.html",
  "/crm/work-order-tech.js",
  "/crm/work-order-tech.css",
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
