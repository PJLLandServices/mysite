// Offline outbound mutation queue + UI banner for the tech WO page.
// Spec §4.3.3 rule #12. Companion to tech-sw.js (which handles GET
// caching). This file handles WRITE buffering: when navigator.onLine
// is false (or a fetch fails with TypeError), the mutation gets
// stashed in IndexedDB and replayed when connectivity returns.
//
// Public API attached to window.PJLOffline:
//   queuedFetch(url, init)    — drop-in replacement for fetch(); returns
//                                the network response when online, or
//                                a synthesized {ok:true, queued:true}
//                                response when offline + queue-eligible
//                                (PATCH/POST). GETs always pass through.
//   pendingCount()            — number of queued mutations
//   on(event, fn)             — "change" event when queue size shifts
//
// Replay strategy: FIFO. Failures (4xx that aren't network errors) drop
// the mutation from the queue with a console warning — server rejected
// it for a real reason, retrying won't help. 5xx halts the loop and
// keeps the item queued for next time. Network errors also keep the
// mutation queued.
//
// Replay triggers (after May 21 fix):
//   1. `online` event (offline → online transition)
//   2. Module first-load (drains anything left from the prior tab close)
//   3. After every enqueue, when navigator.onLine is true (1s debounce)
//   4. 30s heartbeat interval (backstop)
//
// Staleness check (Symptom B defence, OFFLINE_QUEUE_INVESTIGATION.md):
// Before each replay batch, the loop probes each WO's current updatedAt
// once. Any queue entry whose `queuedAt` is older than the server's
// current `updatedAt` AND whose body touches a wholesale-replace field
// (zones, lineItems, etc.) is dropped instead of replayed — replaying
// would clobber the server's newer state with a stale snapshot. Dropped
// entries are counted in `droppedCount()` and surfaced in the banner so
// the tech sees the loss instead of it happening silently.

(function setupOfflineQueue() {
  const DB_NAME = "pjl-tech-offline";
  const DB_VERSION = 1;
  const STORE = "queue";
  const listeners = new Set();
  const drainListeners = new Set();
  let cachedCount = 0;
  // Symptom B defence (May 21 investigation, OFFLINE_QUEUE_INVESTIGATION.md).
  // Counts queue entries dropped because the server's `updatedAt` has moved
  // past the entry's `queuedAt` AND the body touches a wholesale-replace
  // field (`zones`, `lineItems`, etc.). Dropping is safer than replaying a
  // stale snapshot that would clobber newer server state — but the tech
  // needs to see WHEN this happens, so it surfaces in the banner instead of
  // silently disappearing. Resets to 0 on page reload (in-memory only — no
  // dead-letter store this round; that can come in a follow-up if useful).
  let droppedAsStale = 0;
  // Fields where the server's `update()` does a wholesale replace (see
  // lib/work-orders.js:1172 and adjacent). A queued PATCH carrying one of
  // these will overwrite server state with the local snapshot at enqueue
  // time. If the server has moved on since the entry was queued, that's
  // destructive — drop the entry instead.
  const FULL_REPLACE_FIELDS = new Set([
    "zones", "additionalRepairs", "lineItems", "customParts",
    "serviceChecklist", "materialsPacked", "photos"
  ]);

  // ---- IndexedDB helpers ---------------------------------------------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function txStore(mode) {
    const db = await openDb();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async function enqueue(entry) {
    const store = await txStore("readwrite");
    return new Promise((resolve, reject) => {
      const r = store.add({ ...entry, queuedAt: new Date().toISOString() });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function dequeue(id) {
    const store = await txStore("readwrite");
    return new Promise((resolve, reject) => {
      const r = store.delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  async function listAll() {
    const store = await txStore("readonly");
    return new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }

  async function refreshCount() {
    try {
      const all = await listAll();
      cachedCount = all.length;
    } catch {
      cachedCount = 0;
    }
    notify();
    return cachedCount;
  }

  function notify() {
    for (const fn of listeners) {
      try { fn({ count: cachedCount, online: navigator.onLine, droppedAsStale }); }
      catch (err) { console.warn("[offline-queue] listener", err); }
    }
  }

  // Fired once at the end of a replay batch that actually moved server
  // state. Page-side listeners use it to refetch the WO and re-render
  // (replacement for the old location.reload() — see May 22 fix).
  function notifyDrain(payload) {
    for (const fn of drainListeners) {
      try { fn(payload); }
      catch (err) { console.warn("[offline-queue] drain listener", err); }
    }
  }

  // ---- queuedFetch wrapper -------------------------------------------
  async function queuedFetch(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    if (method === "GET") return fetch(url, init);
    // Try the network first. Failing that, queue (only safe methods —
    // PATCH/POST/PUT). DELETE not auto-queued in v1 — too easy to
    // double-delete on resync.
    if (!["PATCH", "POST", "PUT"].includes(method)) return fetch(url, init);

    if (navigator.onLine) {
      try {
        const res = await fetch(url, init);
        return res;
      } catch (err) {
        // Network died mid-flight — fall through to queue.
        console.warn("[offline-queue] network error, queueing:", err?.message);
      }
    }
    // Queue the mutation.
    const body = (init.body && typeof init.body === "string") ? init.body : null;
    const headers = init.headers ? Object.fromEntries(new Headers(init.headers)) : { "content-type": "application/json" };
    // Strip If-Match — queued mutations have lost their concurrency
    // context the moment they were captured locally. By the time
    // replay fires (signal returns, page reload, whenever), the
    // server's wo.updatedAt has moved on (any other PATCH advanced
    // it). Replaying with a stale If-Match → 409 → the replay
    // handler dequeues without retry → the tech's work is silently
    // dropped. Stripping If-Match lets queued replays land. The
    // trade-off: two techs editing the same WO concurrently could
    // overwrite each other's changes via queue. Acceptable — techs
    // don't share WOs in practice, and the alternative (losing
    // captured field work) is worse. Same reasoning for ETag/
    // If-None-Match if anything else ever sets them.
    delete headers["If-Match"];
    delete headers["if-match"];
    delete headers["If-None-Match"];
    delete headers["if-none-match"];
    delete headers.ETag;
    delete headers.etag;
    await enqueue({ url, method, body, headers });
    await refreshCount();
    // Symptom A fix (May 21 investigation): schedule a replay attempt
    // after every enqueue when the device thinks it's online. Without
    // this, a single transient fetch failure leaves the item in the
    // queue with NO future drain trigger (the `online` event only
    // fires on offline→online transitions, not on "online the whole
    // time but one request flaked"). 1s delay debounces against bursts
    // of enqueues during rapid tech taps; replay() itself is guarded
    // by `replayInFlight` so concurrent schedules collapse to one run.
    if (navigator.onLine) setTimeout(replay, 1000);
    // Synthesize a success response so the caller's UI doesn't error.
    // The data field is empty — callers that immediately re-render from
    // the response should be defensive (most patchWorkOrder callers
    // already use the response opportunistically rather than as
    // source-of-truth).
    return new Response(JSON.stringify({ ok: true, queued: true, message: "Saved locally — will sync when online." }), {
      status: 202,
      headers: { "content-type": "application/json" }
    });
  }

  // ---- Replay on reconnect -------------------------------------------
  let replayInFlight = false;
  async function replay() {
    if (replayInFlight) return;
    if (!navigator.onLine) return;
    replayInFlight = true;
    let drainedAny = false;
    let startedWithItems = false;
    let replayedCount = 0;
    let droppedCountThisRun = 0;
    try {
      const all = await listAll();
      startedWithItems = all.length > 0;
      // FIFO — oldest queuedAt first.
      all.sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));

      // Symptom B defence (May 21 investigation): probe each WO's current
      // `updatedAt` ONCE before the loop so we can spot queued snapshots
      // that the server has already moved past. The expensive case (large
      // queue) gets one GET per distinct WO URL, not per item. If a probe
      // fails (offline mid-replay, server down), we skip the staleness
      // check for that URL and fall back to the existing replay behaviour
      // — better to risk an over-replay than to drop work because we
      // couldn't read the server. Only checks GET-able URLs that look
      // like `/api/work-orders/:id` PATCHes; anything else (custom
      // endpoints) gets replayed without the staleness check.
      const wo_urls = [...new Set(
        all.filter((e) => /^\/api\/work-orders\/[^/]+$/.test(e.url) && e.method === "PATCH").map((e) => e.url)
      )];
      const serverUpdatedAtByUrl = {};
      for (const u of wo_urls) {
        try {
          const r = await fetch(u, { cache: "no-store" });
          if (r.ok) {
            const j = await r.json().catch(() => ({}));
            const wo = j.workOrder || j;
            if (wo && wo.updatedAt) serverUpdatedAtByUrl[u] = wo.updatedAt;
          }
        } catch (_e) { /* probe failure → skip the check for this URL */ }
      }

      for (const entry of all) {
        // Staleness check: drop queued PATCHes whose snapshot the server
        // has already moved past, when the payload would wholesale-
        // replace a field. See FULL_REPLACE_FIELDS comment above. This
        // is the Symptom B fix — without it, a stale `zones` snapshot
        // replays and clobbers newer server state on disk.
        const serverUpdatedAt = serverUpdatedAtByUrl[entry.url];
        if (serverUpdatedAt && entry.queuedAt && entry.queuedAt < serverUpdatedAt) {
          let parsedBody = null;
          try { parsedBody = JSON.parse(entry.body || "{}"); } catch { /* tolerate */ }
          if (parsedBody && typeof parsedBody === "object") {
            const touched = Object.keys(parsedBody).filter((k) => FULL_REPLACE_FIELDS.has(k));
            if (touched.length) {
              console.warn(
                "[offline-queue] DROP stale full-replace entry to protect newer server state.",
                "url:", entry.url,
                "queuedAt:", entry.queuedAt,
                "serverUpdatedAt:", serverUpdatedAt,
                "fields:", touched.join(",")
              );
              await dequeue(entry.id);
              droppedAsStale++;
              droppedCountThisRun++;
              drainedAny = true;
              await refreshCount();
              continue;
            }
          }
        }

        try {
          // Defensive strip of concurrency headers on replay — covers
          // legacy queue entries enqueued before the enqueue-time strip
          // landed. A stale If-Match → 409 → silent dequeue → lost work.
          const replayHeaders = { ...(entry.headers || {}) };
          delete replayHeaders["If-Match"];
          delete replayHeaders["if-match"];
          delete replayHeaders["If-None-Match"];
          delete replayHeaders["if-none-match"];
          delete replayHeaders.ETag;
          delete replayHeaders.etag;
          const res = await fetch(entry.url, {
            method: entry.method,
            headers: replayHeaders,
            body: entry.body
          });
          if (res.ok || res.status < 500) {
            await dequeue(entry.id);
            drainedAny = true;
            replayedCount++;
          } else {
            console.warn("[offline-queue] server 5xx during replay, keeping queued:", entry.url, res.status);
            break;
          }
        } catch (err) {
          console.warn("[offline-queue] network error during replay, will retry:", err?.message);
          break;
        }
        await refreshCount();
      }
    } finally {
      replayInFlight = false;
      await refreshCount();
    }
    // Notify the page that server state moved (replayed PATCHes wrote
    // to the WO, and/or stale entries were dropped). The page decides
    // how to react: re-fetch + re-render now if it's safe (no sheet
    // open, no in-flight PATCH), or set a `pendingResync` flag that
    // fires on the next safe moment (Done-tap on a zone sheet, or
    // before the next user-initiated patchWorkOrder).
    //
    // Replaces the May 21 `location.reload()` workaround. That was
    // wiping in-flight PATCHes when the auto-reload fired before the
    // tech's Done-tap save had landed — the "saved then disappears"
    // regression Patrick reported on May 22.
    if (drainedAny && startedWithItems) {
      notifyDrain({ replayed: replayedCount, dropped: droppedCountThisRun });
    }
  }

  // ---- Public API + event wiring -------------------------------------
  window.PJLOffline = {
    queuedFetch,
    pendingCount: () => cachedCount,
    // Exposes the in-memory dropped-as-stale counter so the banner can
    // surface "M dropped" alongside the pending count. Resets on reload
    // (no persistent dead-letter store this round).
    droppedCount: () => droppedAsStale,
    // Manual reset — the banner's "Dismiss" affordance clears the dropped
    // counter after the tech has acknowledged it.
    clearDropped() { droppedAsStale = 0; notify(); },
    on(event, fn) {
      if (event === "change") listeners.add(fn);
      if (event === "drain")  drainListeners.add(fn);
    },
    off(event, fn) {
      if (event === "change") listeners.delete(fn);
      if (event === "drain")  drainListeners.delete(fn);
    },
    refresh: refreshCount,
    replay
  };

  window.addEventListener("online", () => {
    notify();
    replay();
  });
  window.addEventListener("offline", notify);
  // First-load: count what's already queued (e.g., the tab was closed
  // mid-offline) and try to drain.
  refreshCount().then(() => {
    if (navigator.onLine) replay();
  });
  // Heartbeat: belt-and-suspenders backstop against missed `online`
  // events and any future regression that breaks the enqueue auto-
  // trigger above. Idempotent — replay() no-ops when replayInFlight
  // is true or when the queue is empty.
  setInterval(() => {
    if (navigator.onLine && cachedCount > 0) replay();
  }, 30_000);
})();
