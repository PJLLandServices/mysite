// How the field queue talks to the server (PJL-113). Plain JavaScript, no
// React Native imports, so the sync harness (scripts/perf-field-sync.mjs)
// and the tests drive THIS code rather than a copy of it. offline/field.js
// wires it to the app: the host, fetch, the client-version header and the
// app's AuthRequiredError.

// ---- Error classes: the ONE rule for what a failed request means ----------
//
// transient — no signal, a timeout, the server restarting (any 5xx,
//             including Render's HTML 502 page during a deploy), 429, or a
//             version clash the next read resolves. Retried on its own with
//             backoff; never waits for Finish; never holds anything else.
// auth      — 401/403, or the session is another account. Sign in.
// permanent — the server refused this change for a reason a retry will
//             not fix (a conflict to choose, a closed visit, a missing
//             record, a validation 4xx). Held, shown, retried on a tap or
//             at Finish.
//
// Before this, any error that was not network/auth/version_conflict held
// the whole visit until Finish — so one 500 mid-visit queued everything
// recorded after it, and Finish sent it all in one 5–8 minute batch.
const TRANSIENT_CODES = new Set(['network', 'server_unavailable', 'version_conflict', 'server_update', 'rate_limited']);
export function classify(error) {
  const code = error?.code;
  if (code === 'auth' || code === 'owner_mismatch') return 'auth';
  if (TRANSIENT_CODES.has(code)) return 'transient';
  const status = Number(error?.status);
  if (status >= 500 || status === 429) return 'transient';
  if (!code && !status) return 'transient'; // A thrown fetch: no answer at all.
  return 'permanent';
}

const UNAVAILABLE = 'The server is restarting. Your work is kept on this phone and sends on its own.';

// `request(path, { method, body, version, timeout })` → parsed JSON, or a
// thrown error whose `code` classify() understands.
export function createRequest({ host, fetchImpl = fetch, headers = h => h, AuthRequiredError = Error, owner = () => null }) {
  return async function request(path, { method = 'GET', body, version, timeout = 15000 } = {}) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const who = owner();
      const response = await fetchImpl(host + path, {
        method, credentials: 'include', cache: 'no-store', signal: abort.signal,
        headers: headers({
          accept: 'application/json', 'content-type': 'application/json',
          ...(version ? { 'if-match': version } : {}),
          // The account this phone's queued work belongs to. The server
          // refuses a write whose session is another account (403
          // owner_mismatch), so one tech's work cannot land under another's
          // — without a session read before every change.
          ...(who ? { 'x-pjl-field-owner': who } : {}),
        }),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new AuthRequiredError(), { code: data?.error === 'owner_mismatch' ? 'owner_mismatch' : 'auth', status: response.status });
      }
      // Not JSON: Render's deploy page, a proxy, a captive portal. It was
      // read as "signed out" and offered sign-in for a server restart.
      if (!data) {
        throw Object.assign(new Error(UNAVAILABLE), { code: response.status >= 500 || response.status === 429 ? 'server_unavailable' : 'network', status: response.status });
      }
      if (!response.ok || data.ok === false) {
        const transient = response.status >= 500 || response.status === 429;
        throw Object.assign(new Error(data.errors?.[0] || (transient ? UNAVAILABLE : 'The server refused this change.')), {
          status: response.status,
          code: data.error || data.code || (response.status === 429 ? 'rate_limited' : transient ? 'server_unavailable' : 'server'),
          gateFailures: data.gateFailures,
        });
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw Object.assign(new Error('Waiting for a connection. Your recorded work stays on this phone.'), { code: 'network' });
      if (!error.code && !error.status) throw Object.assign(error, { code: 'network' });
      throw error;
    } finally { clearTimeout(timer); }
  };
}

const recordPath = key => (key.startsWith('prop:')
  ? `/api/properties/${encodeURIComponent(key.slice(5))}`
  : `/api/work-orders/${encodeURIComponent(key.slice(3))}`);

// The queue's transport for one account. `view(key)` is the queue's own
// copy, for the property/lead a work-order write response leaves out.
//
// The session is read ONCE per sync pass (verifyOwner), not before every
// change: the server's owner check (x-pjl-field-owner) refuses any write
// made under another account, which is what the per-change reads were for.
// What the session says the server supports is kept from that read.
export function createTransport({ request, account, view, AuthRequiredError = Error }) {
  let session = null;
  // A server from before the owner check (no `ownerCheck` in the session)
  // gets the old per-change session read, so the guarantee never lapses
  // while the phone is ahead of the server.
  const guard = async () => {
    if (session?.fieldOffline?.ownerCheck === 1) return;
    const s = await request('/api/session');
    if (!s.authenticated || s.user?.id !== account) throw Object.assign(new AuthRequiredError(), { code: 'auth' });
    session = s;
  };
  const needs = (flag, message) => {
    if (session?.fieldOffline?.[flag] !== 1) throw Object.assign(new Error(message), { code: 'server_update' });
  };
  const withContext = (key, workOrder) => {
    const prior = view(key);
    return { ...workOrder, property: prior?.property || null, lead: prior?.lead || null };
  };
  return {
    // The server refuses a write under another account by itself, so the
    // queue need not re-read the session on every pass.
    ownerEnforced: () => session?.fieldOffline?.ownerCheck === 1,
    verifyOwner: async () => {
      const s = await request('/api/session');
      if (!s.authenticated || !s.user?.id || !['admin', 'tech'].includes(s.role)) {
        throw Object.assign(new AuthRequiredError(), { code: 'auth' });
      }
      session = s;
      return s.user.id === account;
    },
    read: async key => {
      const data = await request(recordPath(key));
      if (key.startsWith('prop:')) return data.property;
      return { ...data.workOrder, property: data.property || null, lead: data.lead || null };
    },
    patch: async (key, patch, version) => {
      await guard();
      const data = await request(recordPath(key), { method: 'PATCH', body: patch, version });
      if (key.startsWith('prop:')) return data.property;
      return withContext(key, data.workOrder);
    },
    photo: async (key, payload) => {
      await guard();
      needs('photoRetry', 'The server needs the field photo update. Your photo is retained on this phone.');
      const data = await request(`/api/work-orders/${encodeURIComponent(key.slice(3))}/photos`, { method: 'POST', body: { photos: [payload] }, timeout: 90000 });
      // A server without retry support must not silently acknowledge this
      // photo. A deleted photo's upload id is dropped by the server on
      // purpose (PJL-110); that is acknowledged by the delete, not here.
      if (!data.workOrder?.photos?.some(p => p.clientUploadId === payload.clientUploadId)
        && !data.workOrder?.removedPhotos?.some(p => p.clientUploadId === payload.clientUploadId)) {
        throw Object.assign(new Error('The server needs the field photo update. Your photo is retained on this phone.'), { code: 'server_update' });
      }
      return withContext(key, data.workOrder);
    },
    // A queued photo delete or move (PJL-110/111). By upload id when the
    // phone took the photo — it may not know the server's number — else by
    // number.
    photoEdit: async (key, entry) => {
      await guard();
      needs('photoEdit', 'The server needs the photo delete and move update. Your change is kept on this phone.');
      const which = entry.photo.clientUploadId ? `upload/${encodeURIComponent(entry.photo.clientUploadId)}` : String(entry.photo.n);
      const data = await request(`/api/work-orders/${encodeURIComponent(key.slice(3))}/photos/${which}`, entry.kind === 'photoDelete'
        ? { method: 'DELETE' }
        : { method: 'PATCH', body: { zoneNumber: entry.zoneNumber } });
      return withContext(key, data.workOrder);
    },
  };
}
