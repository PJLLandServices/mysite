// Quote view ledger — "did the customer actually open it?" (FLOW-21).
//
// Append-only log of CUSTOMER views of a quote's approval surfaces, one
// entry per view session:
//   { ts, lastTs, quoteId, kind, ip, userAgent, repeats }
//
// WHY A SEPARATE FILE, not a field on the quote:
// quotes.js is read-modify-write over the WHOLE quotes.json with no lock —
// `readAll()` … await … `writeAll()`. That is fine for the handful of
// deliberate mutations it does today, but a page view is a HIGH-FREQUENCY
// write on a customer-triggered path, and interleaving one with
// recordPortalSignAcceptance() could drop the acceptance record on the
// floor. The acceptance record is the money. So view tracking never touches
// quotes.json at all: worst case a view is lost, never a signature.
//
// Mirrors lib/mailer-log.js (the send ledger) deliberately — same file
// shape, same single write chain, same self-pruning. If you are changing
// one, look at the other.
//
// KINDS — the ladder a customer climbs, in order:
//   gate_challenge — the phone gate was SHOWN to them. They have the link
//                    and opened it; they have not seen the document.
//   gate_unlocked  — they passed the phone gate.
//   document       — the designed proposal page was served to them.
//   sign_page      — the standard accept page (line items, totals,
//                    signature pad) loaded its data.
//   pdf            — they downloaded the PDF.
//
// A quote sitting at gate_challenge with no gate_unlocked is the tell for
// "customer says they signed, we have nothing": they never got in.
//
// Storage: server/data/quote-views.json. Never throws, never rejects — a
// ledger failure must never change what a customer sees on the page.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "quote-views.json");

// A quote's life is long — 90-day expiry, then the project it becomes.
// Keep a year so "was this opened?" is still answerable at warranty time.
const RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

// Repeat views of the same kind from the same IP inside this window fold
// into the existing entry (bumping lastTs + repeats) instead of appending.
// One person reading a proposal for twenty minutes is ONE view, not forty —
// otherwise the count is a measure of how many fetches the page makes.
const DEDUPE_MS = 30 * 60 * 1000;

const KINDS = ["gate_challenge", "gate_unlocked", "document", "sign_page", "pdf"];
const KIND_SET = new Set(KINDS);

// Kinds that mean the customer actually saw the OFFER (not just the lock
// screen). `opened` in a summary is derived from these.
const CONTENT_KINDS = new Set(["document", "sign_page", "pdf"]);

// ---- File I/O ---------------------------------------------------------
// All writes funnel through one promise chain so concurrent views can't
// interleave read-modify-write and drop each other's entries.

let writeChain = Promise.resolve();

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, "[]\n", "utf8");
  }
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(records) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(records, null, 2) + "\n", "utf8");
}

function prune(records) {
  const cutoff = Date.now() - RETENTION_MS;
  let kept = records.filter((r) => (Date.parse(r.lastTs || r.ts) || 0) >= cutoff);
  if (kept.length > MAX_ENTRIES) kept = kept.slice(kept.length - MAX_ENTRIES);
  return kept;
}

// ---- Public API -------------------------------------------------------

// Record one customer view. Never throws, never rejects.
//
// The CALLER is responsible for not calling this for staff — see
// recordQuoteView() in server.js, which drops the call when requireUser()
// resolves. Patrick previewing his own proposal is not a customer view, and
// a tracker that counts his own opens is worse than no tracker.
function logView({ quoteId, kind, ip, userAgent } = {}) {
  const id = String(quoteId || "").trim();
  if (!id || !KIND_SET.has(kind)) return writeChain; // nothing worth recording

  const ts = new Date().toISOString();
  const entry = {
    ts,
    lastTs: ts,
    quoteId: id,
    kind,
    ip: String(ip || "").slice(0, 64),
    userAgent: String(userAgent || "").slice(0, 300),
    repeats: 0
  };

  writeChain = writeChain.then(async () => {
    const records = await readAll();
    // Fold into a recent matching entry rather than appending a new one.
    // Scans from the end — the match, if any, is almost always the last
    // few entries.
    const cutoff = Date.now() - DEDUPE_MS;
    let folded = false;
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const r = records[i];
      if ((Date.parse(r.lastTs || r.ts) || 0) < cutoff) break; // older than the window
      if (r.quoteId === entry.quoteId && r.kind === entry.kind && r.ip === entry.ip) {
        r.lastTs = entry.ts;
        r.repeats = (Number(r.repeats) || 0) + 1;
        if (entry.userAgent) r.userAgent = entry.userAgent;
        folded = true;
        break;
      }
    }
    if (!folded) records.push(entry);
    // Prune AFTER the mutation, not before: pruning first and then pushing
    // leaves the store permanently one entry over MAX_ENTRIES.
    await writeAll(prune(records));
  }).catch((err) => {
    console.error("[quote-views] ledger write failed:", err?.message);
  });
  return writeChain;
}

// Roll a quote's raw entries into the shape the admin surfaces render.
// Pure — takes entries, returns a summary. Exported for testing.
function summarize(quoteId, entries) {
  const mine = entries
    .filter((r) => r && r.quoteId === quoteId)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const summary = {
    quoteId,
    count: mine.length,           // deduped view sessions, all kinds
    firstAt: null,
    lastAt: null,
    opened: false,                // saw the actual offer, not just the gate
    firstOpenedAt: null,
    lastOpenedAt: null,
    gateChallengedAt: null,       // first time the phone gate was shown
    gateUnlockedAt: null,         // first time they passed it
    // True when they hit the phone gate and never got through — the
    // "they couldn't open it" signal, not "they didn't bother".
    stuckAtGate: false,
    byKind: {},
    lastIp: "",
    lastUserAgent: ""
  };
  if (!mine.length) return summary;

  for (const r of mine) {
    const last = r.lastTs || r.ts;
    if (!summary.firstAt || r.ts < summary.firstAt) summary.firstAt = r.ts;
    if (!summary.lastAt || last > summary.lastAt) summary.lastAt = last;

    const b = summary.byKind[r.kind] || (summary.byKind[r.kind] = { count: 0, firstAt: null, lastAt: null });
    b.count += 1;
    if (!b.firstAt || r.ts < b.firstAt) b.firstAt = r.ts;
    if (!b.lastAt || last > b.lastAt) b.lastAt = last;

    if (CONTENT_KINDS.has(r.kind)) {
      summary.opened = true;
      if (!summary.firstOpenedAt || r.ts < summary.firstOpenedAt) summary.firstOpenedAt = r.ts;
      if (!summary.lastOpenedAt || last > summary.lastOpenedAt) summary.lastOpenedAt = last;
    }
    if (r.kind === "gate_challenge" && (!summary.gateChallengedAt || r.ts < summary.gateChallengedAt)) {
      summary.gateChallengedAt = r.ts;
    }
    if (r.kind === "gate_unlocked" && (!summary.gateUnlockedAt || r.ts < summary.gateUnlockedAt)) {
      summary.gateUnlockedAt = r.ts;
    }
  }

  summary.stuckAtGate = Boolean(summary.gateChallengedAt) && !summary.gateUnlockedAt && !summary.opened;

  const newest = mine.reduce((acc, r) =>
    (String(r.lastTs || r.ts) > String(acc.lastTs || acc.ts) ? r : acc), mine[0]);
  summary.lastIp = newest.ip || "";
  summary.lastUserAgent = newest.userAgent || "";
  return summary;
}

// One quote's summary, plus its raw events newest-first (for the detail view).
async function summaryFor(quoteId) {
  const id = String(quoteId || "").trim();
  const records = await readAll();
  const summary = summarize(id, records);
  const events = records
    .filter((r) => r && r.quoteId === id)
    .sort((a, b) => String(b.lastTs || b.ts).localeCompare(String(a.lastTs || a.ts)))
    .map((r) => ({
      ts: r.ts,
      lastTs: r.lastTs || r.ts,
      kind: r.kind,
      repeats: Number(r.repeats) || 0,
      ip: r.ip || "",
      userAgent: r.userAgent || ""
    }));
  return { ...summary, events };
}

// { quoteId: summary } for every quote with at least one view. One file
// read for the whole folder listing rather than a fetch per row.
async function summaryMap() {
  const records = await readAll();
  const ids = [...new Set(records.map((r) => r && r.quoteId).filter(Boolean))];
  const out = {};
  for (const id of ids) out[id] = summarize(id, records);
  return out;
}

module.exports = {
  logView,
  summaryFor,
  summaryMap,
  summarize,
  KINDS,
  CONTENT_KINDS: [...CONTENT_KINDS],
  DEDUPE_MS
};
