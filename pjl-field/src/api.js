// Thin wrapper over the CRM's existing JSON API.
//
// Authentication piggybacks on the WebView's session. The WebView is
// mounted with `sharedCookiesEnabled`, which puts the pjl_crm_session
// cookie in the system cookie store — and React Native's fetch reads
// that same store on iOS. So logging in once on the Today tab
// authenticates these calls too, with no token handling of our own.
//
// The consequence worth designing for: before that first login, every
// call here 401s. Screens treat `AuthRequiredError` as a normal state
// with a "sign in on Today" message rather than an error to report.

export const HOST = 'https://www.pjllandservices.com';

export class AuthRequiredError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'AuthRequiredError';
  }
}

async function getJson(path) {
  const res = await fetch(`${HOST}${path}`, {
    headers: { accept: 'application/json' },
    credentials: 'include',
    cache: 'no-store',
  });
  // The CRM redirects unauthenticated browser requests to the login
  // page, so a 200 carrying HTML means "not signed in" just as much as
  // a 401 does. Check both rather than trusting the status alone.
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AuthRequiredError();
  }
  if (!res.ok) throw new Error((data && data.errors && data.errors[0]) || `Request failed (${res.status})`);
  return data;
}

export function listProperties() {
  return getJson('/api/properties').then((d) => d.properties || []);
}

export function getProperty(id) {
  return getJson(`/api/properties/${encodeURIComponent(id)}`).then((d) => d.property || d);
}

export function getToday(dateISO) {
  const q = dateISO ? `?date=${encodeURIComponent(dateISO)}` : '';
  return getJson(`/api/schedule/today${q}`);
}

async function postJson(path) {
  const res = await fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'include',
    body: '{}',
  });
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new AuthRequiredError(); }
  if (!res.ok) throw new Error((data && data.errors && data.errors[0]) || `Request failed (${res.status})`);
  return data;
}

// Sends the customer the on-route SMS + email and stamps
// lead.onRouteNotifiedAt. A real message to a real customer — the screen
// confirms first and disables the button once it has fired.
export const notifyOnRoute = (leadId) =>
  postJson(`/api/leads/${encodeURIComponent(leadId)}/notify-on-route`);

// Returns the lead's existing work order, or CREATES one when it has
// none. The caller knows which case it is from the row's `workOrder`
// field, and confirms before the creating case.
export const openWorkOrder = (leadId) =>
  postJson(`/api/leads/${encodeURIComponent(leadId)}/open-wo`);

// ---- work orders -----------------------------------------------------

// The endpoint returns { workOrder, property, lead, ... } — property as a
// SIBLING of the work order, not nested inside it. This used to return
// d.workOrder alone and drop the rest, which is why writing a corrected
// zone name back to the property silently did nothing: the screen read
// wo.property.system.zones, got undefined, mapped an empty array, and the
// "don't wipe the zones" guard swallowed it without a word. Carry the
// property (and the lead) on the work order the screens already pass around.
export const getWorkOrder = (id) =>
  getJson(`/api/work-orders/${encodeURIComponent(id)}`).then((d) => {
    if (!d?.workOrder) return d;
    return { ...d.workOrder, property: d.property || null, lead: d.lead || null };
  });

// Where a work-order photo actually lives. The stored record carries `n`,
// not a url — building the URI here keeps every screen that shows a
// thumbnail from having to know that.
export const woPhotoUri = (woId, photo) =>
  photo?.n != null ? `${HOST}/api/work-orders/${encodeURIComponent(woId)}/photo/${photo.n}` : null;

// Every work order on a property, newest first from the server. Used
// before creating one so a second tap opens what the first tap made
// instead of raising a duplicate.
export const listPropertyWorkOrders = (propertyId) =>
  getJson(`/api/work-orders?propertyId=${encodeURIComponent(propertyId)}`)
    .then((d) => d.workOrders || []);

async function sendJson(path, method, body) {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new AuthRequiredError(); }
  if (!res.ok) throw new Error((data && data.errors && data.errors[0]) || `Request failed (${res.status})`);
  return data;
}

export const patchWorkOrder = (id, patch) =>
  sendJson(`/api/work-orders/${encodeURIComponent(id)}`, 'PATCH', patch);

// Raise a work order against a PROPERTY rather than a lead. A booking
// written from a season plan — how a management company's route days get
// scheduled — has no lead, so /api/leads/:id/open-wo has no id to take.
// This is the same call the CRM's own property page makes.
export const createWorkOrderForProperty = ({ type, propertyId }) =>
  sendJson('/api/work-orders', 'POST', { type, propertyId }).then((d) => d.workOrder);

// Sweeps every issue off the work order's zones into the property's
// deferred recommendations. Takes no payload — the server reads the
// zones. Called once, at finish.
export const deferIssues = (id) =>
  sendJson(`/api/work-orders/${encodeURIComponent(id)}/issues/defer`, 'POST');

// The zone label a tech corrects on site belongs to the property, not
// just to today's visit — that is the whole point of correcting it.
export const patchProperty = (id, patch) =>
  sendJson(`/api/properties/${encodeURIComponent(id)}`, 'PATCH', patch);

// photos: [{ mediaType, data (base64, no data: prefix), category, zoneNumber, label }]
// 90-second timeout, matching the web page: slow cellular is normal,
// but "forever" is not a state a tech can act on.
export async function uploadWoPhotos(id, photos) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${HOST}/api/work-orders/${encodeURIComponent(id)}/photos`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ photos }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new AuthRequiredError(); }
    if (!res.ok) throw new Error((data && data.errors && data.errors[0]) || `Upload failed (${res.status})`);
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Upload timed out after 90 seconds. Try again when you have more signal.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
