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
// Replay strategy: FIFO. Failures (4xx/5xx that aren't network errors)
// drop the mutation from the queue with a console warning — server
// rejected it for a real reason, retrying won't help. Network errors
// keep the mutation queued for the next online attempt.

(function setupOfflineQueue() {
  const DB_NAME = "pjl-tech-offline";
  const DB_VERSION = 1;
  const STORE = "queue";
  const listeners = new Set();
  let cachedCount = 0;

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
      try { fn({ count: cachedCount, online: navigator.onLine }); }
      catch (err) { console.warn("[offline-queue] listener", err); }
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
    await enqueue({ url, method, body, headers });
    await refreshCount();
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
    try {
      const all = await listAll();
      startedWithItems = all.length > 0;
      // FIFO — oldest queuedAt first.
      all.sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
      for (const entry of all) {
        try {
          const res = await fetch(entry.url, {
            method: entry.method,
            headers: entry.headers,
            body: entry.body
          });
          if (res.ok || res.status < 500) {
            await dequeue(entry.id);
            drainedAny = true;
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
    // Auto-refresh the page after a successful drain so the UI picks
    // up fresh server state (the replayed PATCHes mutated the WO
    // server-side; cached state in `state` is stale until we re-fetch).
    // Skip if the user is mid-edit (active textarea / input has focus
    // with unsubmitted text) so we don't lose typing in flight.
    if (drainedAny && startedWithItems && cachedCount === 0) {
      const active = document.activeElement;
      const userTyping = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT") && active.value !== active.defaultValue;
      if (!userTyping) {
        // Small delay so the offline banner gets a chance to show "Syncing 0 pending changes…" before reload.
        setTimeout(() => location.reload(), 350);
      } else {
        console.log("[offline-queue] drained but user is typing — skipping auto-reload");
      }
    }
  }

  // ---- Public API + event wiring -------------------------------------
  window.PJLOffline = {
    queuedFetch,
    pendingCount: () => cachedCount,
    on(event, fn) {
      if (event === "change") listeners.add(fn);
    },
    off(event, fn) {
      if (event === "change") listeners.delete(fn);
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
})();
