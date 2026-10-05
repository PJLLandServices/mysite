// Memory-usage logging, so an out-of-memory restart leaves a trail.
//
// Background (2026-10-05): Render restarted the service for exceeding its
// memory limit after nine hours of uptime, and the log held nothing for the
// 41 minutes before it — the server does not log ordinary requests, so
// there was no way to tell a slow climb from one heavy request, or which
// request it was.
//
// Three kinds of line, all prefixed `[mem]`:
//   1. A heartbeat once a minute: the level, and how many requests are open.
//      Read down the column to see a climb.
//   2. A jump: memory rose JUMP_MB or more between two samples a few seconds
//      apart. Names every request open at that moment.
//   3. A heavy request: memory was JUMP_MB or more higher when a request
//      finished than when it started. Under concurrency the blame is
//      approximate (two overlapping requests each see the other's memory),
//      which is why the jump line lists everything open.
//
// Read-only: measures and prints, changes no behaviour. `rss` is the figure
// Render's limit applies to; `heap` is JavaScript objects; `external` is
// Buffers and native memory Node knows about. rss far above heap+external
// is native memory (sharp/libvips) or allocator fragmentation.

const MB = 1024 * 1024;
const SAMPLE_MS = 5000;
const HEARTBEAT_MS = 60 * 1000;
const JUMP_MB = 30;

const mb = (bytes) => Math.round(bytes / MB);

function formatUsage(usage) {
  return `rss=${mb(usage.rss)}MB heap=${mb(usage.heapUsed)}MB external=${mb(usage.external)}MB`;
}

// The route, never the query string, with long opaque path segments
// (portal and approval tokens) replaced so a credential is not written to
// the log. Short ids (WO-2026-0123) are kept: they are what Patrick needs.
function routeLabel(method, pathname) {
  const safe = String(pathname || "")
    .split("/")
    .map((seg) => (/^[A-Za-z0-9_.~-]{24,}$/.test(seg) ? ":token" : seg))
    .join("/")
    .slice(0, 120);
  return `${String(method || "GET").toUpperCase()} ${safe}`;
}

function createMemoryLog({
  memoryUsage = () => process.memoryUsage(),
  now = () => Date.now(),
  log = (line) => console.log(line),
  jumpMb = JUMP_MB,
  heartbeatMs = HEARTBEAT_MS
} = {}) {
  const open = new Map(); // id -> { label, startedAt, rss }
  let nextId = 1;
  let lastSampleRss = null;
  let lastHeartbeatAt = null;

  function openLabels() {
    const t = now();
    return [...open.values()].map((r) => `${r.label} (${Math.round((t - r.startedAt) / 1000)}s)`);
  }

  // Call when a request arrives; call the returned function when it ends.
  function requestStarted(method, pathname) {
    const id = nextId++;
    const entry = { label: routeLabel(method, pathname), startedAt: now(), rss: memoryUsage().rss };
    open.set(id, entry);
    let finished = false;
    return function requestFinished() {
      if (finished) return;
      finished = true;
      open.delete(id);
      const usage = memoryUsage();
      const grew = mb(usage.rss - entry.rss);
      if (grew >= jumpMb) {
        const secs = ((now() - entry.startedAt) / 1000).toFixed(1);
        log(`[mem] heavy request: ${entry.label} +${grew}MB in ${secs}s -> ${formatUsage(usage)}`);
      }
    };
  }

  function sample() {
    const usage = memoryUsage();
    const t = now();
    if (lastSampleRss != null) {
      const grew = mb(usage.rss - lastSampleRss);
      if (grew >= jumpMb) {
        const labels = openLabels();
        log(`[mem] jump +${grew}MB -> ${formatUsage(usage)} | open: ${labels.length ? labels.join(", ") : "none (background work)"}`);
      }
    }
    lastSampleRss = usage.rss;
    if (lastHeartbeatAt == null || t - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = t;
      log(`[mem] ${formatUsage(usage)} open=${open.size}`);
    }
  }

  // unref'd: this timer must never be what keeps a draining process alive.
  function start(sampleMs = SAMPLE_MS) {
    sample();
    const timer = setInterval(sample, sampleMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  return { requestStarted, sample, start, openCount: () => open.size };
}

module.exports = { createMemoryLog, formatUsage, routeLabel, JUMP_MB };
