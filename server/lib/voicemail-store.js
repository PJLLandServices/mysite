// Voicemail recording tokens — map an unguessable public token to a Twilio
// recording so the SMS/email "Listen" link can be served through our own
// server instead of the raw api.twilio.com Recording URL.
//
// Why this exists: Twilio's media URL (api.twilio.com/.../Recordings/RE….mp3)
// prompts for the account's Basic-auth credentials when opened in a browser.
// Patrick set Twilio up purely via API creds in env vars and never logs into
// the Console, so that link is a dead end on his phone. Instead we hand out a
// token-keyed URL on pjllandservices.com; the proxy endpoint authenticates to
// Twilio server-side (it already has the creds in env) and streams the audio
// back. See GET /api/voicemail/recording/:token in server.js.
//
// Schema (one record):
//   {
//     token: "<48-hex>",           // the credential; IS the URL path segment
//     recordingSid: "RE…",         // Twilio recording SID (dedup key)
//     recordingUrl: "https://api.twilio.com/.../Recordings/RE…",
//     callSid: "CA…",
//     from: "+1…",
//     createdAt, expiresAt          // ISO timestamps
//   }
//
// Storage: server/data/voicemail-recordings.json — same flat-file pattern as
// magic-tokens.js. Voicemails are infrequent; a JSON array is plenty.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "voicemail-recordings.json");

// How long a "Listen" link stays live. 30 days: long enough that an alert
// sitting in Patrick's inbox stays playable, short enough that a forwarded
// SMS doesn't expose the recording indefinitely. After this the token 404s
// (the recording itself lives on per Twilio's own retention settings).
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) await fs.writeFile(FILE, "[]\n", "utf8");
}

async function readAll() {
  await ensureFile();
  try {
    const parsed = JSON.parse((await fs.readFile(FILE, "utf8")) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(records) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(records, null, 2) + "\n", "utf8");
}

// Drop expired records so the file doesn't grow forever. Idempotent.
function prune(records, now) {
  return records.filter((r) => (Date.parse(r.expiresAt) || 0) > now);
}

// Mint (or reuse) a token for a recording. Both the recorded and the
// transcription webhooks call this for the same recording; keying on
// recordingSid means they share ONE token/URL rather than minting two.
// Returns the token string.
async function mintToken({ recordingSid, recordingUrl, callSid, from } = {}) {
  if (!recordingUrl) throw new Error("recordingUrl is required to mint a voicemail token.");
  const now = Date.now();
  let records = prune(await readAll(), now);

  if (recordingSid) {
    const existing = records.find((r) => r.recordingSid === recordingSid);
    if (existing) {
      await writeAll(records); // persist the prune
      return existing.token;
    }
  }

  const token = crypto.randomBytes(24).toString("hex");
  records.push({
    token,
    recordingSid: recordingSid || null,
    recordingUrl,
    callSid: callSid || null,
    from: from || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TOKEN_TTL_MS).toISOString()
  });
  await writeAll(records);
  return token;
}

// Resolve a token to its record, or null if unknown/expired. Prunes lazily.
async function resolveToken(token) {
  if (!token || typeof token !== "string") return null;
  const now = Date.now();
  const records = await readAll();
  const record = records.find((r) => r.token === token);
  if (!record) return null;
  if ((Date.parse(record.expiresAt) || 0) <= now) return null;
  return record;
}

module.exports = { mintToken, resolveToken, TOKEN_TTL_MS };
