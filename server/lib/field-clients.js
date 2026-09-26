// Which field-app code each phone is really running, as the phone reports it.
//
// Every request from the field app carries `x-pjl-client:
// commit=…;source=…;run=…;update=…;runtime=…;channel=…`
// (pjl-field/src/clientVersion.mjs). This records it per signed-in user and
// writes ONE log line when a user's reported version changes:
//
//   [field-client] tech@… (tech) runs commit=<sha> source=build run=41 update=embedded runtime=4737af92… channel=production
//
// That line is the server-side half of "is the release on the phone?": the
// Today tab shows the commit to a person, this shows the same commit to the
// log, and the two must agree. GET /api/admin/field-clients lists the latest
// report per user.
//
// Memory only, on purpose. The log line is the durable record (Render keeps
// it); the map is a convenience that a restart rebuilds on the next request.
// Nothing here can reject or slow a request — a missing or malformed header
// is simply not recorded.

const FIELDS = ["commit", "source", "run", "update", "runtime", "channel"];
const SAFE = /^[A-Za-z0-9._:#/+-]{0,64}$/;
const MAX_USERS = 200;

const seen = new Map();

function parseClientVersion(header) {
  if (!header || typeof header !== "string" || header.length > 600) return null;
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!FIELDS.includes(key) || !SAFE.test(value)) continue;
    out[key] = value;
  }
  return out.commit ? out : null;
}

const describe = (v) => FIELDS.map((k) => `${k}=${v[k] || ""}`).join(" ");

// who: { id, email, role } of the signed-in user, or null (not signed in yet).
function noteClientVersion(header, who, { now = new Date(), log = console.log } = {}) {
  const v = parseClientVersion(header);
  if (!v) return null;
  const key = who?.id || who?.email || "signed-out";
  const label = who ? `${who.email || who.id} (${who.role || "?"})` : "signed-out phone";
  const prev = seen.get(key);
  const text = describe(v);
  if (!prev || prev.text !== text) {
    log(`[field-client] ${label} runs ${text}`);
    if (!seen.has(key) && seen.size >= MAX_USERS) seen.delete(seen.keys().next().value);
    seen.set(key, { user: label, version: v, text, firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString() });
  } else {
    prev.lastSeenAt = now.toISOString();
  }
  return v;
}

// True when this report would write a log line (new user or new version),
// so the caller looks up the user's email only then, not on every request.
function wouldLog(header, who) {
  const v = parseClientVersion(header);
  if (!v) return false;
  const prev = seen.get(who?.id || who?.email || "signed-out");
  return !prev || prev.text !== describe(v);
}

function listClientVersions() {
  return [...seen.values()]
    .map(({ user, version, firstSeenAt, lastSeenAt }) => ({ user, version, firstSeenAt, lastSeenAt }))
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
}

module.exports = { parseClientVersion, noteClientVersion, wouldLog, listClientVersions, CLIENT_VERSION_HEADER: "x-pjl-client" };
