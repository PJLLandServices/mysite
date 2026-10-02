import { AppState } from 'react-native';
import { HOST, AuthRequiredError, withClientVersion } from '../api';
import { createQueue } from './queue.mjs';
import { readLocal, writeLocal, storeForOwner } from './storage';

const queues = new Map();
const woKey = id => `wo:${id}`;
const recordPath = key => key.startsWith('prop:')
  ? `/api/properties/${encodeURIComponent(key.slice(5))}`
  : `/api/work-orders/${encodeURIComponent(key.slice(3))}`;
async function request(path, { method = 'GET', body, version, timeout = 15000 } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  try {
    const response = await fetch(HOST + path, {
      method, credentials: 'include', cache: 'no-store', signal: abort.signal,
      headers: withClientVersion({ accept: 'application/json', 'content-type': 'application/json', ...(version ? { 'if-match': version } : {}) }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 || response.status === 403) throw Object.assign(new AuthRequiredError(), { code: 'auth' });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw Object.assign(new AuthRequiredError(), { code: 'auth' }); }
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.errors?.[0] || 'The server refused this change.'), {
      status: response.status, code: data.error || data.code || 'server', gateFailures: data.gateFailures,
    });
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Waiting for a connection. Your recorded work stays on this phone.'), { code: 'network' });
    throw error;
  } finally { clearTimeout(timer); }
}
async function sessionOwner() {
  const s = await request('/api/session');
  if (!s.authenticated || !s.user?.id || !['admin', 'tech'].includes(s.role)) {
    throw Object.assign(new AuthRequiredError(), { code: 'auth' });
  }
  return s.user.id;
}
async function owner() {
  try {
    const id = await sessionOwner();
    writeLocal('last-owner', id);
    return id;
  } catch (error) {
    if (error.code || error.status) {
      if (error.code !== 'network') throw error;
    }
    const last = readLocal('last-owner');
    if (last) return last;
    throw error;
  }
}
function forOwner(id) {
  if (!queues.has(id)) {
    const transport = {
      verifyOwner: async () => (await sessionOwner()) === id,
      read: async key => {
        const data = await request(recordPath(key));
        if (key.startsWith('prop:')) return data.property;
        return { ...data.workOrder, property: data.property || null, lead: data.lead || null };
      },
      patch: async (key, patch, version) => {
        if ((await sessionOwner()) !== id) throw Object.assign(new AuthRequiredError(), { code: 'auth' });
        const data = await request(recordPath(key), { method: 'PATCH', body: patch, version });
        if (key.startsWith('prop:')) return data.property;
        const prior = queues.get(id).view(key);
        return { ...data.workOrder, property: prior?.property || null, lead: prior?.lead || null };
      },
      photo: async (key, payload) => {
        const session = await request('/api/session');
        if (!session.authenticated || session.user?.id !== id) throw Object.assign(new AuthRequiredError(), { code: 'auth' });
        if (session.fieldOffline?.photoRetry !== 1) throw Object.assign(new Error('The server needs the field photo update. Your photo is retained on this phone.'), { code: 'server_update' });
        const data = await request(`/api/work-orders/${encodeURIComponent(key.slice(3))}/photos`, { method: 'POST', body: { photos: [payload] }, timeout: 90000 });
        // A server without retry support must not silently acknowledge this
        // photo. Deploy the server change before installing the new app.
        if (!data.workOrder?.photos?.some(p => p.clientUploadId === payload.clientUploadId)) {
          throw Object.assign(new Error('The server needs the field photo update. Your photo is retained on this phone.'), { code: 'server_update' });
        }
        const prior = queues.get(id).view(key);
        return { ...data.workOrder, property: prior?.property || null, lead: prior?.lead || null };
      },
    };
    queues.set(id, createQueue({ store: storeForOwner(id), transport }));
  }
  return queues.get(id);
}
export async function openFieldWorkOrder(id) {
  const account = await owner();
  const queue = forOwner(account);
  const key = woKey(id);
  try {
    const data = await request(`/api/work-orders/${encodeURIComponent(id)}`);
    if (data.property?.id) queue.seed(`prop:${data.property.id}`, data.property);
    queue.seed(key, { ...data.workOrder, property: data.property || null, lead: data.lead || null });
  } catch (error) {
    if (error.code === 'auth' || error.status || !queue.view(key)) throw error;
  }
  queue.draft('device', 'openWorkOrder', { id });
  return { queue, key, account, workOrder: queue.view(key) };
}
export async function restoreFieldWorkOrder() {
  const account = await owner();
  const queue = forOwner(account);
  const saved = queue.getDraft('device', 'openWorkOrder');
  return saved?.id ? queue.view(woKey(saved.id)) : null;
}
export function forgetOpenFieldWorkOrder() {
  const account = readLocal('last-owner');
  if (account) forOwner(account).clearDraft('device', 'openWorkOrder');
}
export async function fieldDay(date) {
  const account = await owner();
  const day = date || (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const key = `day:${account}:${day}`;
  try {
    const data = await request(`/api/schedule/today?date=${encodeURIComponent(day)}`);
    writeLocal(key, data);
    return data;
  } catch (error) {
    const cached = readLocal(key);
    if (error.code === 'auth' || error.status || !cached) throw error;
    return { ...cached, offline: true };
  }
}
export function watchFieldQueue(queue) {
  const retry = () => { if (AppState.currentState === 'active') queue.flush().catch(() => {}); };
  const timer = setInterval(retry, 15000);
  const subscription = AppState.addEventListener('change', state => { if (state === 'active') retry(); });
  retry();
  return () => { clearInterval(timer); subscription.remove(); };
}
export function startFieldSync() {
  let cancelled = false, stop;
  owner().then(id => { if (!cancelled) stop = watchFieldQueue(forOwner(id)); }).catch(() => {});
  return () => { cancelled = true; stop?.(); };
}
// One place that writes to the visit's tech notes for the office (office-
// only; never on the customer's report). Used when the phone has to keep
// something the office would otherwise never see (PJL-98).
const techNoteText = lines => [`Field app, ${new Date().toISOString().slice(0, 10)} — kept so nothing is lost:`, ...lines].join('\n');
function appendTechNote(queue, key, lines, { clearDrafts = [] } = {}) {
  if (!lines.length) return;
  const current = queue.view(key)?.techNotes || '';
  const text = techNoteText(lines);
  queue.patch(key, { techNotes: current ? `${current}\n\n${text}` : text }, { clearDrafts });
}
const shownValue = v => {
  if (v == null || v === '') return '(blank)';
  const text = typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
};
const clashLabel = (path, onProperty) => `${onProperty ? 'Property: ' : ''}${path.replace(/^zones › zone (\S+)/, 'Zone $1')}`;
const draftText = d => [d?.label ? `label "${d.label}"` : '', d?.notes ? `notes "${d.notes}"` : '',
  d?.repairs && d?.types?.length ? `repairs: ${d.types.join(', ')}` : ''].filter(Boolean).join(', ') || 'no text';
// The property half of removing a zone (PJL-98 gap 3). The visit half is
// already saved, through the queue, before this runs — so a phantom zone
// is never walked or billed whatever happens here. `removeOnServer` is
// api.js removePropertyZone (the audited, admin-only DELETE). If the
// property record cannot follow — a tech session until PJL-86, or no
// signal — the office is told on the visit's notes, never "Not signed in".
export async function removeZoneFromProperty(queue, key, { number, reason = '', note = '', reasonLabel = '' }, removeOnServer) {
  const wo = queue.view(key);
  const propertyId = wo?.property?.id || wo?.propertyId;
  if (!propertyId) return { ok: true };
  try {
    const property = await removeOnServer(propertyId, number, { reason, note });
    if (property?.id) queue.seed(`prop:${property.id}`, property);
    return { ok: true };
  } catch (err) {
    const permission = err?.code === 'forbidden';
    const why = [reasonLabel, note].filter(Boolean).join(' — ');
    appendTechNote(queue, key, [`• Zone ${number} was removed on site${why ? ` (${why})` : ''}, but the property record still lists it: ${
      permission ? 'removing zones needs the office for now' : 'the phone could not update it'}.`]);
    queue.flush().catch(() => {});
    return { ok: false, message: permission
      ? `Zone ${number} is off this visit. Removing it from the property record needs the office for now — it's noted on the work order for them.`
      : `Zone ${number} is off this visit. The property record couldn't be updated from here — it's noted on the work order for the office.` };
  }
}
export async function flushBeforeFinish(queue, key) {
  if (queue.status(key).drafts) throw new Error('There are zone drafts on this phone. Open those zones and record their assessment before signing off.');
  // A draft on a zone that has left the visit (the office removed it) can
  // never be opened again: its text goes to the office, and it stops
  // holding sign-off (PJL-98 gap 2).
  const stale = queue.zoneDrafts ? queue.zoneDrafts(key).stale : [];
  appendTechNote(queue, key, stale.map(name =>
    `• Zone ${name.slice(5)} is no longer on this visit, so its unrecorded draft was not applied: ${draftText(queue.getDraft(key, name))}.`),
  { clearDrafts: stale });
  await queue.flush({ retry: true });
  const state = queue.status(key);
  // The code travels with the message so Finish can offer the way out of a
  // conflict (keep mine / use office's) instead of a dead end.
  if (state.pending) throw Object.assign(new Error(state.error?.message || 'Connect to sync the recorded work before completing this visit.'), { code: state.error?.code || null });
  const propertyId = queue.view(key)?.property?.id;
  const propertyState = propertyId ? queue.status(`prop:${propertyId}`) : null;
  if (propertyState?.pending) throw Object.assign(new Error(propertyState.error?.message || 'The property corrections still need to sync before completing this visit.'), { code: propertyState.error?.code || null });
}
// A true conflict (the office changed the same zone field the tech did)
// is the tech's call, and he must always be able to make it on the phone.
// Resolves the visit and its property correction together, then syncs.
//
// Keep mine overrides the office, so what the office had goes into the
// visit's tech notes in the same commit (PRD D4, PJL-98 gap 4): the field
// copy wins and nothing the office typed is lost. Use office's needs no note.
export async function resolveFieldConflicts(queue, key, prefer) {
  const propertyId = queue.view(key)?.property?.id;
  for (const k of [key, propertyId ? `prop:${propertyId}` : null]) {
    const error = k ? queue.status(k).error : null;
    if (error?.code !== 'conflict') continue;
    const lines = prefer === 'mine'
      ? (error.clashes || []).map(c => `• ${clashLabel(c.path, k !== key)}: the office had ${shownValue(c.theirs)}; the phone's ${shownValue(c.mine)} was kept.`)
      : [];
    queue.resolveConflict(k, prefer, lines.length ? { note: { key, field: 'techNotes', text: techNoteText(lines) } } : {});
  }
  await queue.flush({ retry: true });
  return fieldStatus(queue, key);
}
export function fieldStatus(queue, key) {
  const visit = queue.status(key);
  const id = queue.view(key)?.property?.id;
  const property = id ? queue.status(`prop:${id}`) : null;
  return { ...visit, pending: visit.pending + (property?.pending || 0), error: visit.error || property?.error || null };
}
export function pendingPhotoUri(queue, photo) {
  if (!photo.pending) return null;
  const payload = queue.photoPayload(photo.clientUploadId);
  return payload ? `data:${payload.mediaType};base64,${payload.data}` : null;
}
