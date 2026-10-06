"use strict";

// Reserve receipts — makes POST /api/booking/reserve safe to RETRY.
//
// THE PROBLEM. A caller (the Field app's Add Stop, the PJL Assistant, a
// browser on a flaky signal) sends a booking, the server writes it, and the
// reply is lost. The caller sees "nothing was created" and sends it again —
// and the server, which has no memory of the first request, books it twice
// (PJL-87). The booking lock cannot help: the two requests are sequential,
// not simultaneous.
//
// THE FIX. The caller puts a `clientRequestId` (any string ≤ 80 chars it
// generated once, e.g. a UUID) on the request. After a successful reserve
// the server files the reply under that id. A repeat of the same id within
// 24 hours gets the ORIGINAL reply back — same leadId, same booking — and
// nothing is written. Requests without the field behave exactly as before.
//
// Receipts live in data/reserve-receipts.json, written atomically like the
// other stores. Expired receipts are dropped on every write.

const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-json");

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ID_LENGTH = 80;

function createReceipts({ dataDir, now = Date.now }) {
  const FILE = path.join(dataDir, "reserve-receipts.json");

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function normalizeId(raw) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || id.length > MAX_ID_LENGTH || /[\r\n]/.test(id)) return "";
    return id;
  }

  // The filed reply for this id, or null. Expiry is decided on read.
  function lookup(clientRequestId) {
    const id = normalizeId(clientRequestId);
    if (!id) return null;
    const hit = readAll().find((r) => r.id === id && r.expiresAt > now());
    return hit ? { status: hit.status, body: hit.body } : null;
  }

  // File a successful reply. Only 2xx replies are receipts — a refusal must
  // be retryable, because the retry may well succeed (slot freed, typo fixed).
  async function file(clientRequestId, status, body) {
    const id = normalizeId(clientRequestId);
    if (!id || status < 200 || status >= 300) return false;
    const t = now();
    const kept = readAll().filter((r) => r.expiresAt > t && r.id !== id);
    kept.push({ id, status, body, filedAt: new Date(t).toISOString(), expiresAt: t + TTL_MS });
    await writeJsonAtomic(FILE, kept);
    return true;
  }

  return { FILE, TTL_MS, MAX_ID_LENGTH, lookup, file, normalizeId };
}

module.exports = { createReceipts, TTL_MS, MAX_ID_LENGTH };
