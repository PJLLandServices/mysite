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

// Lock the work order without a customer signature. Nobody was home,
// which on a fall closing is the normal case rather than the exception.
// The reason vocabulary is the server's (BYPASS_REASONS); it locks the
// work order but does NOT complete it — completion is the separate call
// below, same as the web page.
export const signatureBypass = (id, { reason, note }) =>
  sendJson(`/api/work-orders/${encodeURIComponent(id)}/signature-bypass`, 'POST', { reason, note });

// Sign (when there is someone to sign) and complete, in one PATCH — the
// server applies the signature, flips status, AWAITS the completion
// cascade, and hands back the invoice it drafted. Pass no signature to
// complete a work order already locked by a bypass.
//
// A refusal here is usually `presign_gate_unmet` with the unmet gates
// listed in `gateFailures`; the caller shows them rather than a dead end,
// because every one of them is something the tech can still fix on site.
export async function completeWorkOrder(id, { signature = null, arrivedAt = null, departedAt = null } = {}) {
  const body = { status: 'completed' };
  if (signature) body.signature = signature;
  if (arrivedAt) body.arrivedAt = arrivedAt;
  if (departedAt) body.departedAt = departedAt;
  const res = await fetch(`${HOST}/api/work-orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new AuthRequiredError(); }
  if (!res.ok || !data.ok) {
    const err = new Error((data && data.errors && data.errors[0]) || `Couldn't complete (${res.status})`);
    // Carried so the screen can list what is still unmet instead of
    // showing one sentence and no way forward.
    if (data && data.error === 'presign_gate_unmet' && Array.isArray(data.gateFailures)) {
      err.gateFailures = data.gateFailures;
    }
    throw err;
  }
  return data;   // { ok, workOrder, cascade? }
}

// ---- invoices --------------------------------------------------------

export const getInvoice = (id) =>
  getJson(`/api/invoices/${encodeURIComponent(id)}`).then((d) => d.invoice || d);

// Every invoice raised against one address, newest first — the server
// sorts by createdAt descending and filters, so the phone never
// downloads the whole business to show three rows.
//
// `overdue` is NOT a status the server has. The real set is draft, sent,
// partially_paid, paid, void; an invoice is overdue when it was SENT and
// still carries a balance, which is a question about two fields and a
// date rather than a state anything stores. isOverdue() below is the one
// place that decides it.
export const listPropertyInvoices = (propertyId) =>
  getJson(`/api/invoices?propertyId=${encodeURIComponent(propertyId)}`)
    .then((d) => d.invoices || []);

// Sent, still owed, and past the grace period. Kept here rather than in a
// screen because the property list and anything added later have to agree
// about what "overdue" means — two definitions is how a red badge starts
// disagreeing with a total.
export const OVERDUE_AFTER_DAYS = 14;

export function isOverdue(invoice, now = Date.now()) {
  if (!invoice || !invoice.sentAt) return false;
  if (!(Number(invoice.balanceDue) > 0)) return false;
  if (invoice.status === 'void' || invoice.status === 'paid') return false;
  const sent = new Date(invoice.sentAt).getTime();
  if (!Number.isFinite(sent)) return false;
  return now - sent > OVERDUE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

// Emails the invoice to the customer. The server owns the template, the
// attachments and the send log.
export const sendInvoice = (id) =>
  sendJson(`/api/invoices/${encodeURIComponent(id)}/send`, 'POST', {});

// The customer's own payment page, minted without sending anything — a
// draft invoice has no payable link until this runs. The app never talks
// to Stripe; it opens this URL and the server does the rest.
export const invoicePaymentLink = (id) =>
  sendJson(`/api/invoices/${encodeURIComponent(id)}/payment-link`, 'POST', {}).then((d) => d.url);

// Record money that arrived OUTSIDE our pay page — cash, a cheque, or a
// card tapped on the phone through Stripe's own app.
//
// `card_qb` is not a QuickBooks-only method despite its name: it is what
// the pay page already records a Stripe charge as, it renders as plain
// "Card", and reversing one warns "refund in Stripe first" — all correct
// for a Tap to Pay charge. Recording a tap as anything else would file
// card revenue under Other.
//
// The server owns the ledger: it derives amountPaid, balanceDue and the
// invoice status from the payments it holds. This only reports what was
// collected.
export const recordInvoicePayment = (id, { amount, method, notes = '' }) =>
  sendJson(`/api/invoices/${encodeURIComponent(id)}/payments`, 'POST', {
    amount,
    method,
    receivedAt: new Date().toISOString(),
    notes,
  });

// ---- Booking -----------------------------------------------------------
//
// The SAME endpoints the public booking page uses, deliberately. A second
// booking path is a second set of rules about who may book, how far the
// drive corridor stretches, and what a slot costs — and the two would
// drift on the first change to either. What differs here is only who is
// asking: an admin session lets the server skip Turnstile and honour a
// `leadId`, which is how a booking lands on an EXISTING customer instead
// of minting a duplicate.

// Google Places suggestions as you type. Staff-gated and proxied, because
// a React Native screen has no browser to run the Places JS SDK in — the
// CRM's own pages get autocomplete by binding that SDK to
// `.js-address-autocomplete`, which is not available here.
//
// Suggestions ONLY. Whatever is picked still goes through verifyAddress,
// so the booking gate and the coordinates come from one place and a
// suggestion can never skip them.
export const suggestAddresses = (q) =>
  getJson(`/api/admin/address-suggest?q=${encodeURIComponent(q)}`)
    .then((d) => ({
      suggestions: d.suggestions || [],
      // "no_key" means GOOGLE_MAPS_SERVER_KEY is not set on the server;
      // "upstream" means Google refused or timed out. Passed through so
      // the screen can say WHY nothing is suggesting instead of looking
      // broken — the address box still works either way.
      degraded: d.degraded || null,
    }));

export const listServices = () =>
  getJson('/api/booking/services').then((d) => d.services || {});

// The gate, run before a calendar is drawn: junk and out-of-area
// addresses are refused here rather than after the customer has picked a
// day. Also hands back Google's formatted address, which is what gets
// stored — the geocode is sourced BEFORE any date is suggested, exactly
// as the web booking page does it.
export const verifyAddress = (address) =>
  sendJson('/api/booking/verify-address', 'POST', { address });

// The SAME shape the website's picker asks for: a from/to range rather
// than the legacy "only days that have slots" call.
//
// This matters for more than tidiness. Without from/to the server groups
// only the days that HAVE availability, so a screen showing nothing
// cannot tell the difference between "the calendar is full", "we are out
// of season for this service" and "this address is outside the route
// area for every day in the window". With the range, every day comes
// back carrying a `reason` — which is what the desktop picker reads, and
// why it can say something useful instead of going blank.
const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const BOOKING_WINDOW_DAYS = 42;

export const bookingAvailability = ({ service, address }) => {
  const from = new Date();
  const to = new Date(from.getTime() + BOOKING_WINDOW_DAYS * 86400000);
  return getJson(
    `/api/booking/availability?service=${encodeURIComponent(service)}`
    + `&address=${encodeURIComponent(address)}`
    + `&from=${encodeURIComponent(dateKey(from))}`
    + `&to=${encodeURIComponent(dateKey(to))}`,
  );
};

// Why a day has no slots, in words. The server's own reason codes
// (lib/availability.js expandDaysToRange): a screen that says "no space"
// for every one of these is lying about three of them.
export const DAY_REASONS = {
  past: null,                       // never worth saying
  closed: null,                     // an ordinary non-working day
  season_not_open: 'Bookings for this service have not opened yet',
  season_closed: 'This service is out of season',
  outside_route_area: 'Too far from the routes running that week',
  no_availability: 'Fully booked',
};

// The single sentence to show when NOTHING in the window is bookable.
// Picks the reason that actually dominates rather than assuming "full".
export function whyNoDays(days) {
  const counts = new Map();
  for (const d of days || []) {
    if (d?.slots?.length) return null;              // there IS availability
    const r = d?.reason;
    if (!r || r === 'past' || r === 'closed') continue;
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  if (!counts.size) return 'No open days in the next six weeks.';
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const label = DAY_REASONS[top[0]];
  return label ? `${label}.` : 'No open days in the next six weeks.';
}

// Two shapes, one route. With `leadId` the booking attaches to a customer
// already on file; without it the server builds a new lead from `contact`.
// `leadId` is only honoured for an admin session, which is the server's
// own rule, not ours.
export const reserveBooking = (payload) =>
  sendJson('/api/booking/reserve', 'POST', payload);

// Who is signed in. Book is admin-only — a tech booking work onto the
// calendar is a business decision, not a field one — and the tab hides
// itself rather than showing a locked door.
export const getSession = () =>
  getJson('/api/session').then((d) => ({
    authenticated: Boolean(d.authenticated),
    role: d.role || null,
    user: d.user || null,
  }));

// ---- Portal messages ----------------------------------------------------
//
// The customer's side of these lives in the CRM's portal, NOT in the
// phone's Messages app. iOS gives an app no access to SMS or iMessage
// content at all — Apple does not expose it, to anyone, at any
// entitlement level — so "show me the customer's texts" is not a thing
// that can be built. What CAN be shown is this thread, which is the
// conversation PJL actually owns a record of.
//
// The fence is `user` (server.js needsAuth), so a tech reads and replies
// on the same footing as an admin. No admin gate here.

export const listThreads = () =>
  getJson('/api/admin/portal-messages').then((d) => ({
    threads: d.threads || [],
    totalUnread: d.totalUnread || 0,
  }));

export const getThread = (leadId) =>
  getJson(`/api/admin/portal-messages/${encodeURIComponent(leadId)}`).then((d) => d.thread || null);

// Marks every CUSTOMER message on the thread read. Called when the
// thread is opened, which is the moment the claim becomes true.
export const markThreadRead = (leadId) =>
  postJson(`/api/admin/portal-messages/${encodeURIComponent(leadId)}/read`);

// The server's own cap (normalizeString(payload.message, 1500)). Held
// here so the composer can stop the tech at the same number rather than
// letting the server silently truncate a reply they thought they sent
// whole.
export const REPLY_MAX = 1500;

// A reply is COMMITTED to the thread and then EMAILED to the customer,
// fire-and-forget — the server does `.catch(() => {})` on the send, so a
// dead SMTP leaves the reply in the thread with nobody told. It is not
// a text message and must never be presented as one.
export const replyToThread = (leadId, message) =>
  sendJson(`/api/admin/portal-messages/${encodeURIComponent(leadId)}/reply`, 'POST', { message })
    .then((d) => d.message || null);

// Sweeps every issue off the work order's zones into the property's
// deferred recommendations. Takes no payload — the server reads the
// zones. Called once, at finish.
export const deferIssues = (id) =>
  sendJson(`/api/work-orders/${encodeURIComponent(id)}/issues/defer`, 'POST');

// The zone label a tech corrects on site belongs to the property, not
// just to today's visit — that is the whole point of correcting it.
export const patchProperty = (id, patch) =>
  sendJson(`/api/properties/${encodeURIComponent(id)}`, 'PATCH', patch);

// Remove a documented zone, with a reason. The server writes the audit
// entry itself and never renumbers what's left — a controller station
// keeps its number whatever happens to the ones before it.
export const removePropertyZone = (propertyId, zoneNumber, { reason, note }) =>
  sendJson(
    `/api/properties/${encodeURIComponent(propertyId)}/zones/${encodeURIComponent(zoneNumber)}`,
    'DELETE',
    { reason, note }
  ).then((d) => d.property);

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
