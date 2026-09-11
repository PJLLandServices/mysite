# "We're updating" page (Cloudflare Worker)

Replaces Render's black **502 Bad Gateway** page during deploys with a
branded page that reloads itself when the site is back.

**Why deploys 502 at all:** the Render web service has a persistent disk,
which disables Render's zero-downtime deploys. Fixing that properly means
splitting the public site off the Node service — deferred (see
`claude/DEPLOY_502_FIX_PLAN_2026-09-11.md` in the Claude project).

## How it works

- Cloudflare proxies `www.pjllandservices.com` (orange cloud).
- This Worker runs on route `www.pjllandservices.com/*`.
- Browser page loads (GET/HEAD with `Accept: text/html`) that get a
  502/503/504 HTML reply, or no reply, receive `worker.js`'s inline page
  with **HTTP 503 + Retry-After** (search engines treat that as temporary).
- Everything else — `/api/*`, `/healthz`, assets, video, form POSTs, and the
  app's own text/plain or JSON error replies — passes through untouched.
- The page polls `/healthz` (served by `server/server.js`) every 3 s and
  calls `location.reload()` once it answers 200.

## Setup (one time, Cloudflare dashboard)

1. **SSL/TLS → Overview:** encryption mode **Full** (Render requires this
   before proxying).
2. **DNS:** the `www` CNAME → `…onrender.com`: set Proxy status to
   **Proxied**. Leave the bare-domain A record as is (Render redirects it).
3. **Workers & Pages → Create → Start with Hello World → Edit code:** paste
   `worker.js`, Deploy.
4. On the Worker → **Settings → Domains & Routes → Add → Route:**
   `www.pjllandservices.com/*`, zone `pjllandservices.com`.
5. Test: push any commit; open the site during the deploy.

## Rollback

Remove the route (step 4) or flip `www` back to **DNS only**. The site is
served by Render exactly as before.

## Changing the page

Edit the `HTML` template at the bottom of `worker.js`, re-paste into the
Cloudflare editor, Deploy. Phone number and copy live there; brand colours
mirror `style.css`.
