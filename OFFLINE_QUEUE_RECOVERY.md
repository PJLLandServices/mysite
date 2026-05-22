# Offline Queue Recovery — Field Procedure

When a tech-mode work order shows **"Syncing N pending changes…"** that doesn't drop, the IndexedDB outbound queue (`server/offline-queue.js`) has accumulated mutations that aren't being replayed. This document is the playbook for diagnosing and recovering without losing the tech's work.

> Companion file: `server/offline-queue.js` for the code, `SYSTEM_OVERVIEW.md` for the architecture row.

---

## 1. How to identify a stuck queue

**Visible signs on the tech phone:**

- The yellow banner across the top reads `Syncing N pending change(s)…` and the number does not decrease for ≥30 seconds.
- The number is anomalously high (>20 for a typical mid-visit; >50 is definitely stuck).
- The banner does NOT say `Offline —` — the device thinks it's online.
- Bottom-of-screen "Saved" indicator continues to flash when the tech taps things (UI is queuing locally, not actually saving).
- Optional: dragging down to refresh shows a stale WO state — recent edits aren't reflected after reload.

**On the server side (admin desktop, viewing the same WO):**

- The tech's recent changes are missing from the desktop view.
- `wo.updatedAt` is older than the tech's latest visible UI activity.

If the banner says **"Offline — N changes saved locally…"** that's normal offline behaviour. The stuck-queue state is specifically when the banner says **"Syncing N pending changes…"** and the number is not draining.

---

## 2. What NOT to do

The following actions destroy the queue (and the tech's work):

- **❌ Do NOT close the Safari tab.** IndexedDB persists across tab closes, but if the tab is closed mid-replay the queue may be left in an inconsistent state.
- **❌ Do NOT force-quit Safari** from the App Switcher. Same reason.
- **❌ Do NOT clear browsing data / website data** for `pjllandservices.com`. This wipes the IndexedDB store. Every queued mutation is permanently lost.
- **❌ Do NOT install iOS updates** while the queue is stuck. Some updates wipe Safari's IndexedDB.
- **❌ Do NOT toggle airplane mode** as a "reset" — it can fire a spurious `online` event that triggers replay against a half-connected network.
- **❌ Do NOT clear the queue by manipulating IndexedDB** from DevTools unless you've exported it first (see §5).

Anything that nukes the local IndexedDB store nukes the tech's work. Treat the queue like an unsaved document.

---

## 3. Remote-inspect the iPhone from a Mac

The recovery starts with reading what's actually in the queue.

**Prerequisites:**
- Mac with Safari installed.
- USB-C / Lightning cable to the iPhone.
- Both Mac and iPhone signed into the same Apple ID is NOT required — just the cable and trust.
- On the iPhone: **Settings → Safari → Advanced → Web Inspector → ON.** (One-time setup.)

**Steps:**

1. Plug the iPhone into the Mac via cable. Tap "Trust this computer" if prompted on the phone.
2. Open Safari on the Mac.
3. Mac Safari menu bar: **Develop → [iPhone name] → [Tab title showing the WO]**. If you don't see Develop, enable it in Safari → Settings → Advanced → "Show features for web developers".
4. A Web Inspector window opens, scoped to that tab.
5. Click the **Storage** tab.
6. In the left sidebar, expand **IndexedDB → pjl-tech-offline → queue**.
7. Click into individual entries to see their shape.

You should see entries shaped like:

```json
{
  "id": 1,
  "url": "/api/work-orders/WO-XXXXXXXX",
  "method": "PATCH",
  "body": "{\"zones\":[...]}",
  "headers": { "content-type": "application/json" },
  "queuedAt": "2026-05-21T14:33:12.901Z"
}
```

**Document the following before doing anything else:**

- Total item count (cross-check against the banner's number).
- Oldest `queuedAt` timestamp and newest `queuedAt` timestamp.
- Whether all items target the same `url` (one WO) or multiple WOs.
- Spot-check the body of items at the head (oldest) and tail (newest) of the queue. Symptom B (data deletes) is most likely caused by stale `zones` snapshots at the head being replayed over newer server state.

---

## 4. Manually replay queued items one at a time

Once you have a snapshot, decide whether to drain the queue interactively or let the auto-replay run.

**Read-only inspection (safe, recommended first):**

In the Web Inspector **Console** tab on the iPhone session, paste:

```js
window.PJLOffline.pendingCount()
```

You should see the count.

```js
// Get the IndexedDB store and list everything
(async () => {
  const db = await indexedDB.open("pjl-tech-offline").then(r =>
    new Promise(res => { r.onsuccess = () => res(r.result); })
  );
  const tx = db.transaction("queue", "readonly").objectStore("queue");
  const all = await new Promise(res => { tx.getAll().onsuccess = e => res(e.target.result); });
  console.table(all.map(e => ({ id: e.id, url: e.url, method: e.method, queuedAt: e.queuedAt, bodyKeys: Object.keys(JSON.parse(e.body || "{}")).join(",") })));
})()
```

This prints a table of every queued item without changing anything.

**Controlled single-item retry (when you've identified a likely poison item):**

```js
// Replay one specific item by id. Pick an id from the inspection above.
const ITEM_ID = 1;  // change to the actual id
(async () => {
  const db = await indexedDB.open("pjl-tech-offline").then(r =>
    new Promise(res => { r.onsuccess = () => res(r.result); })
  );
  const item = await new Promise(res => {
    db.transaction("queue").objectStore("queue").get(ITEM_ID).onsuccess = e => res(e.target.result);
  });
  console.log("About to send:", item);
  const res = await fetch(item.url, { method: item.method, headers: item.headers, body: item.body });
  console.log("Response:", res.status, await res.text().catch(() => "(no body)"));
})()
```

Read the response. If it's a 4xx or 5xx, that's the poison item — note the error and decide whether to skip it (see §6).

**Trigger the full replay loop (online auto-drain):**

```js
window.PJLOffline.replay()
```

This invokes the same replay logic that fires on the `online` event. Watch the count drop in real time.

If the count doesn't move, check:
- Is `navigator.onLine` true? (`navigator.onLine` in the console.)
- Is there a 5xx in the Network tab during replay? (5xx halts the loop.)
- Is there a JS exception in the Console tab?

---

## 5. Export queue contents to JSON for later analysis

Before any destructive action, dump the queue to clipboard so the data isn't lost.

In the iPhone session's Console:

```js
(async () => {
  const db = await indexedDB.open("pjl-tech-offline").then(r =>
    new Promise(res => { r.onsuccess = () => res(r.result); })
  );
  const tx = db.transaction("queue", "readonly").objectStore("queue");
  const all = await new Promise(res => { tx.getAll().onsuccess = e => res(e.target.result); });
  copy(JSON.stringify(all, null, 2));
  console.log(`Copied ${all.length} entries to clipboard. Paste into a file.`);
})()
```

Paste the clipboard into a `.json` file on the Mac. This is your safety net. With this dump, the work can be reconstructed and replayed against the server by hand if everything else fails.

---

## 6. Last-resort procedure if data must be discarded

> **WARNING: This procedure destroys queued work. Only use after §5 export and after confirming the items genuinely cannot be replayed.**

If a single poison item is jamming the queue and can't be made to land server-side (e.g., the WO it targets has been deleted, the payload is malformed beyond repair, the customer no longer exists), you can surgically remove that one item:

```js
// Delete a specific queue entry by id. DESTROYS that item.
const ITEM_ID = 1;  // change to the id of the poison item
(async () => {
  const db = await indexedDB.open("pjl-tech-offline").then(r =>
    new Promise(res => { r.onsuccess = () => res(r.result); })
  );
  await new Promise(res => {
    db.transaction("queue", "readwrite").objectStore("queue").delete(ITEM_ID).onsuccess = res;
  });
  await window.PJLOffline.refresh();
  console.log("Deleted. Remaining:", window.PJLOffline.pendingCount());
})()
```

Then call `window.PJLOffline.replay()` to drain the rest.

If the entire queue must be discarded (catastrophic — last resort):

```js
// NUCLEAR: wipes the entire queue. DESTROYS all queued work.
(async () => {
  const db = await indexedDB.open("pjl-tech-offline").then(r =>
    new Promise(res => { r.onsuccess = () => res(r.result); })
  );
  await new Promise(res => {
    db.transaction("queue", "readwrite").objectStore("queue").clear().onsuccess = res;
  });
  await window.PJLOffline.refresh();
})()
```

After a clear, reload the page. The tech will need to re-enter any work that wasn't already on the server. Use the §5 export to figure out what was lost so it can be re-entered (or back-filled by Patrick from the desktop view).

---

## 7. After recovery — file a report

Save the §5 export plus your notes (counts, oldest timestamp, response codes seen during replay) to a dated folder under `docs/offline-queue-incidents/`. Each stuck-queue event is a data point toward identifying the systemic fix. The investigation that produced this document found two structural issues that are likely candidates for future fix briefs; until those land, treat every stuck queue as a recoverable but informative event.

---

*Last updated: 2026-05-21 during the May 21 stuck-queue investigation.*
