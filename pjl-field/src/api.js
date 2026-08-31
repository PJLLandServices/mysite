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
