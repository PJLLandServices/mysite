import { AppState } from 'react-native';
import { HOST, AuthRequiredError } from '../api';
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
      headers: { accept: 'application/json', 'content-type': 'application/json', ...(version ? { 'if-match': version } : {}) },
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
export async function flushBeforeFinish(queue, key) {
  if (queue.status(key).drafts) throw new Error('There are zone drafts on this phone. Open those zones and record their assessment before signing off.');
  await queue.flush({ retry: true });
  const state = queue.status(key);
  if (state.pending) throw new Error(state.error?.message || 'Connect to sync the recorded work before completing this visit.');
  const propertyId = queue.view(key)?.property?.id;
  const propertyState = propertyId ? queue.status(`prop:${propertyId}`) : null;
  if (propertyState?.pending) throw new Error(propertyState.error?.message || 'The property corrections still need to sync before completing this visit.');
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
