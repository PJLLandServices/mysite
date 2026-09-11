/**
 * PJL "We're updating" page — Cloudflare Worker for www.pjllandservices.com
 *
 * Why this exists: the Render web service has a persistent disk, so every
 * deploy stops the old instance before the new one boots. For ~10–20 s
 * Render's edge answers with its own black "502 Bad Gateway" page, which
 * never refreshes itself. This Worker sits in front (Cloudflare proxy must
 * be ON for www) and, when a visitor asks for a *page* and the origin is
 * down, serves a branded "We're updating" page that polls /healthz and
 * reloads itself the moment the site is back.
 *
 * What it does NOT touch: API calls, images, video, CSS/JS, form posts —
 * anything that isn't a browser navigation for HTML passes through
 * untouched, status and all. The app's own 502/503 replies (text/plain
 * or JSON) are never masked.
 *
 * Deploy: Cloudflare dashboard → Workers & Pages → Create → paste this file
 * → add a Route for "www.pjllandservices.com/*" on zone pjllandservices.com.
 * No secrets, no bindings.
 */

const OUTAGE_STATUSES = new Set([502, 503, 504]);
const POLL_PATH = "/healthz"; // served by server/server.js, never cached

function isPageRequest(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("accept") || "";
  if (!accept.includes("text/html")) return false;
  // Never intercept the poll itself or any API/asset path.
  const { pathname } = new URL(request.url);
  if (pathname === POLL_PATH || pathname.startsWith("/api/")) return false;
  return true;
}

function looksLikeAppReply(response) {
  // The Node app's own error replies are text/plain or JSON. Render's
  // outage page (and a dead origin) is text/html or nothing at all.
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  return ct.startsWith("text/plain") || ct.startsWith("application/json");
}

export default {
  async fetch(request) {
    if (!isPageRequest(request)) return fetch(request);

    let response;
    try {
      response = await fetch(request);
    } catch {
      return updatingPage(request); // origin unreachable entirely
    }
    if (OUTAGE_STATUSES.has(response.status) && !looksLikeAppReply(response)) {
      return updatingPage(request);
    }
    return response;
  },
};

function updatingPage(request) {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // 503 + Retry-After tells Google this is temporary — don't de-index.
    "retry-after": "15",
    "x-pjl-updating": "1",
  };
  if (request.method === "HEAD") return new Response(null, { status: 503, headers });
  return new Response(HTML, { status: 503, headers });
}

const HTML = `<!DOCTYPE html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>We're updating — PJL Land Services</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --green:#1B4D2E;--green-mid:#2D6A42;--green-pale:#EAF3DE;
    --amber:#E07B24;--amber-light:#F59B4A;--cream:#FAFAF5;--white:#fff;
    --text:#1A1A1A;--text-mid:#4A4A4A;--text-muted:#6E6E66;--border:#E2E0D4;
    --r-lg:18px;--touch:44px;
  }
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;min-height:100%}
  body{
    font-family:'DM Sans',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    color:var(--text);background:var(--cream);
    display:flex;flex-direction:column;min-height:100vh;
    padding:clamp(20px,4vw,48px) clamp(16px,4vw,40px);
    -webkit-font-smoothing:antialiased;
  }
  main{margin:auto;width:100%;max-width:34rem}
  .card{
    background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);
    box-shadow:0 4px 32px rgba(27,77,46,.12);overflow:hidden;
  }
  .mark{
    background:var(--green);padding:clamp(22px,5vw,34px) clamp(20px,5vw,32px);
    display:flex;align-items:center;gap:clamp(12px,3vw,18px);
  }
  .mark svg{width:clamp(72px,18vw,96px);height:auto;flex:0 0 auto}
  .mark span{
    font-family:'Barlow Condensed',Impact,'Arial Narrow',sans-serif;font-weight:600;
    color:var(--white);font-size:clamp(1.05rem,3.2vw,1.35rem);line-height:1.15;
    letter-spacing:.02em;text-transform:uppercase;
  }
  .body{padding:clamp(22px,5vw,34px) clamp(20px,5vw,32px)}
  .eyebrow{
    display:inline-flex;align-items:center;gap:.5rem;font-size:.85rem;font-weight:500;
    color:var(--green-mid);background:var(--green-pale);border-radius:999px;
    padding:.35rem .8rem;margin:0 0 1rem;
  }
  .dot{
    width:.55rem;height:.55rem;border-radius:50%;background:var(--amber);
    animation:pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
  h1{
    font-family:'Barlow Condensed',Impact,'Arial Narrow',sans-serif;font-weight:700;
    text-transform:uppercase;letter-spacing:.01em;color:var(--green);
    font-size:clamp(2rem,7vw,2.9rem);line-height:1.02;margin:0 0 .75rem;
  }
  p{font-size:clamp(1rem,2.6vw,1.08rem);line-height:1.6;color:var(--text-mid);margin:0 0 1rem}
  p.small{font-size:.9rem;color:var(--text-muted);margin:0}
  .actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:1.5rem 0 1.25rem}
  .btn{
    display:inline-flex;align-items:center;justify-content:center;gap:.5rem;
    min-height:var(--touch);padding:.7rem 1.25rem;border-radius:10px;
    font-weight:500;font-size:1rem;text-decoration:none;cursor:pointer;
    border:2px solid transparent;transition:background .15s,border-color .15s;
    flex:1 1 12rem;
  }
  .btn-primary{background:var(--amber);color:#fff}
  .btn-primary:hover,.btn-primary:focus-visible{background:var(--amber-light)}
  .btn-secondary{background:var(--white);color:var(--green);border-color:var(--green)}
  .btn-secondary:hover,.btn-secondary:focus-visible{background:var(--green-pale)}
  .btn:focus-visible{outline:3px solid var(--amber);outline-offset:2px}
  .btn:active{transform:translateY(1px)}
  footer{text-align:center;font-size:.85rem;color:var(--text-muted);padding-top:1.5rem}
  @media (prefers-reduced-motion:reduce){.dot{animation:none}}
</style>
</head>
<body>
<main>
  <div class="card" role="status" aria-live="polite">
    <div class="mark" aria-hidden="true">
      <svg viewBox="70 32 295 152" preserveAspectRatio="xMidYMid meet"><defs><clipPath id="c"><path d="M80.4 44.4h280.8v131.1H80.4z"/></clipPath></defs><g clip-path="url(#c)"><path transform="matrix(.749276 0 0 .749276 80.4 44.42)" fill="none" stroke="#fff" stroke-width="10" d="M0 0h374.8v175H0z"/></g><g fill="#fff"><g transform="translate(111.876 163.686)"><path d="M75.324-108.891H14.273c-1.059 0-3.703.395-3.703 4.625v10.442c0 4.094 2.644 4.492 3.703 4.492H71.89c3.301 0 5.68.926 7.004 2.906 1.453 1.984 2.113 5.152 2.113 9.516 0 4.36-.66 7.53-2.113 9.515-1.324 1.98-3.703 2.906-7.004 2.906H14.273c-1.059 0-3.703.395-3.703 4.492v55.504c0 4.098 2.644 4.625 3.703 4.625H26.43c1.059 0 3.699-.527 3.699-4.625V-44.93l45.195-.133c8.988 0 15.461-2.777 19.426-8.324 3.965-5.55 5.816-13.48 5.816-23.922v.793c0-10.57-1.851-18.5-5.816-23.918-3.965-5.684-10.438-8.457-19.426-8.457z"/></g><g transform="translate(180.564 161.739)"><path d="M42.117-104.293v69.527c0 9.094-1.336 14.711-7.62 14.711-6.286 0-7.622-5.617-7.622-16.047H2.81v4.012c0 21.66 8.289 33.96 32.355 33.96 22.73 0 32.36-12.3 32.36-33.695v-72.468z"/></g><g transform="translate(256.769 161.739)"><path d="M68.86 0v-21.93H32.09v-82.363H6.684V0z"/></g></g></svg>
      <span>PJL Land<br>Services</span>
    </div>
    <div class="body">
      <span class="eyebrow"><span class="dot"></span> Quick update in progress</span>
      <h1>We're updating the site</h1>
      <p>This takes <strong>about 30 seconds</strong>. This page will reload itself as soon as we're back — no need to do anything.</p>
      <div class="actions">
        <a class="btn btn-primary" href="tel:+19059600181">Call 905-960-0181</a>
        <button class="btn btn-secondary" type="button" onclick="location.reload()">Try again now</button>
      </div>
      <p class="small">Need sprinkler service today? Call or text and we'll take it from there.</p>
    </div>
  </div>
  <footer>PJL Land Services &middot; Newmarket, Ontario</footer>
</main>
<script>
(function () {
  var tries = 0;
  function check() {
    tries++;
    fetch("${POLL_PATH}", { cache: "no-store", credentials: "omit" })
      .then(function (r) { if (r.ok) location.reload(); else schedule(); })
      .catch(schedule);
  }
  function schedule() {
    // 3 s while the deploy is finishing, backing off to 10 s after ~2 min
    // so a longer outage doesn't hammer the origin from every open tab.
    setTimeout(check, tries < 40 ? 3000 : 10000);
  }
  setTimeout(check, 3000);
})();
</script>
</body>
</html>`;
